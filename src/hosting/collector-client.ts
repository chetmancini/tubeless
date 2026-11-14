import type { PipelineTraceEvent } from "../tracing/tracing.js";
import type { AttemptBatchAcknowledgement } from "./attempt-store.js";
import { assertAttemptId } from "./attempt-store.js";
import { withRetry } from "../utilities/retry.js";
import { awaitWithAbort } from "../utilities/abort.js";
import { readBoundedBody } from "../utilities/read-body.js";
import {
  COLLECTOR_BATCH_BYTES,
  COLLECTOR_BATCH_EVENTS,
  COLLECTOR_RESPONSE_BYTES,
  COLLECTOR_MESSAGE_BYTES,
  batchReplySchema,
  claimReplySchema,
  failureReplySchema,
  decodeCollectorJson,
} from "./collector-protocol.js";
import { decodeAttemptEvent } from "./attempt-batch.js";

class CollectorRequestError extends Error {
  constructor(
    readonly status: number,
    readonly retryable: boolean
  ) {
    super(
      status === 0
        ? "Collector delivery could not be confirmed."
        : `Collector request failed (${status}).`
    );
    this.name = "CollectorRequestError";
  }
}

/** One fresh worker invocation. Retry delivery, never execution or an uncertain claim. */
export function createHostedCollectorClient(options: {
  readonly baseUrl: string;
  readonly launchId: string;
  readonly attemptId: string;
  readonly deploymentId: string;
  readonly token: string;
  readonly fetch?: typeof fetch;
  readonly signal?: AbortSignal;
}) {
  const { baseUrl, launchId, attemptId, deploymentId, token, signal: callerSignal } = options;
  const base = new URL(baseUrl);
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash)
    throw new Error("Collector requires an HTTPS base URL without credentials, query or fragment.");
  for (const id of [launchId, attemptId, deploymentId]) assertAttemptId(id);
  if (!/^[a-f0-9]{32}\.[a-f0-9]{64}$/.test(token)) throw new Error("Invalid collector credential.");
  const origin = base.href.replace(/\/+$/, "");
  const endpoint = `${origin}/v1/launches/${encodeURIComponent(launchId)}`;
  const workerId = crypto.randomUUID();
  const transport = options.fetch ?? fetch;
  const encoder = new TextEncoder();
  let claimed = false;
  let requestedClaim = false;
  let ending = false;
  let sequence = 0;
  let tail: Promise<unknown> = Promise.resolve();

  async function request(
    operation: string,
    body: Uint8Array,
    retry: boolean
  ): Promise<Uint8Array | undefined> {
    return withRetry(
      async () => {
        const controller = new AbortController();
        const timer = setTimeout(
          () => controller.abort(new DOMException("Collector request timed out.", "TimeoutError")),
          10_000
        );
        const signal = callerSignal
          ? AbortSignal.any([controller.signal, callerSignal])
          : controller.signal;
        try {
          const pending = transport(`${endpoint}/${operation}`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${token}`,
              "content-type": "application/json",
              "x-tubeless-worker-id": workerId,
            },
            body: new Uint8Array(body),
            signal,
            redirect: "error",
            credentials: "omit",
            cache: "no-store",
            referrerPolicy: "no-referrer",
          });
          void pending.then(
            (response) => {
              if (signal.aborted) void response.body?.cancel().catch(() => {});
            },
            () => {}
          );
          const response = await awaitWithAbort(pending, signal, "Collector request");
          if (!response.ok) {
            void response.body?.cancel().catch(() => {});
            if (response.status === 410 && operation === "batches") return undefined;
            throw new CollectorRequestError(
              response.status,
              response.status === 408 || response.status === 429 || response.status >= 500
            );
          }
          if (
            response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
            "application/json"
          ) {
            void response.body?.cancel().catch(() => {});
            throw new CollectorRequestError(response.status, false);
          }
          return await readBoundedBody(response.body, COLLECTOR_RESPONSE_BYTES, signal);
        } catch (cause) {
          if (cause instanceof CollectorRequestError) throw cause;
          // Keep provider/body/URL details out of errors and preserve only delivery uncertainty.
          throw new CollectorRequestError(
            0,
            cause instanceof TypeError || controller.signal.aborted
          );
        } finally {
          clearTimeout(timer);
        }
      },
      {
        maxAttempts: retry ? 4 : 1,
        baseDelayMs: 100,
        signal: callerSignal,
        shouldRetry: (cause) => cause instanceof CollectorRequestError && cause.retryable,
      }
    );
  }

  return {
    workerId,
    async claim(): Promise<boolean> {
      if (requestedClaim) return false;
      requestedClaim = true;
      const bytes = await request(
        "admit",
        encoder.encode(JSON.stringify({ attemptId: attemptId, deploymentId: deploymentId })),
        false
      );
      if (!bytes) throw new CollectorRequestError(0, false);
      claimed = decodeCollectorJson(bytes, claimReplySchema).admitted;
      return claimed;
    },
    append(events: readonly PipelineTraceEvent[]): Promise<AttemptBatchAcknowledgement> {
      if (ending) return Promise.reject(new CollectorRequestError(0, false));
      // Own JSON snapshots before queueing, so callers cannot change a pending request.
      let owned: PipelineTraceEvent[];
      try {
        owned = events.map((event) => decodeAttemptEvent(JSON.parse(JSON.stringify(event))));
      } catch {
        return Promise.reject(new CollectorRequestError(0, false));
      }
      const delivery = tail.then(async (): Promise<AttemptBatchAcknowledgement> => {
        if (!claimed || owned.length === 0) throw new CollectorRequestError(0, false);
        const batches: Uint8Array[] = [];
        let group: PipelineTraceEvent[] = [];
        const encode = (items: PipelineTraceEvent[]) =>
          encoder.encode(
            JSON.stringify({
              attemptId: attemptId,
              sequence: sequence + batches.length,
              events: items,
            })
          );
        for (const event of owned) {
          const candidate = [...group, event];
          if (
            candidate.length > COLLECTOR_BATCH_EVENTS ||
            encode(candidate).byteLength > COLLECTOR_BATCH_BYTES
          ) {
            if (group.length === 0) throw new CollectorRequestError(413, false);
            batches.push(encode(group));
            group = [];
          }
          group.push(event);
          if (encode(group).byteLength > COLLECTOR_BATCH_BYTES)
            throw new CollectorRequestError(413, false);
        }
        if (group.length) batches.push(encode(group));
        let acknowledgement: AttemptBatchAcknowledgement = { accepted: false };
        for (const bytes of batches) {
          const response = await request("batches", bytes, true);
          if (!response) {
            claimed = false;
            return { accepted: false };
          }
          const ack = decodeCollectorJson(response, batchReplySchema);
          if (!ack.accepted || ack.runId === undefined) throw new CollectorRequestError(0, false);
          acknowledgement = { accepted: true, runId: ack.runId };
          sequence++;
        }
        return acknowledgement;
      });
      tail = delivery;
      void delivery.catch(() => {});
      return delivery;
    },
    async reportFailure(message: string): Promise<boolean> {
      if (!claimed || ending) throw new CollectorRequestError(0, false);
      if (encoder.encode(message).byteLength > COLLECTOR_MESSAGE_BYTES)
        throw new CollectorRequestError(413, false);
      ending = true;
      await tail.catch(() => {});
      const bytes = encoder.encode(
        JSON.stringify({ attemptId: attemptId, failureId: crypto.randomUUID(), message })
      );
      const response = await request("failure", bytes, true);
      if (!response) throw new CollectorRequestError(0, false);
      const result = decodeCollectorJson(response, failureReplySchema).recorded;
      claimed = false;
      return result;
    },
  };
}
