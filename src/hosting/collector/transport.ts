import type { WireSchema } from "../../tracing/wire-schema.js";
import type { AttemptBatchAcknowledgement } from "../attempt/store.js";
import { assertAttemptId } from "../attempt/store.js";
import { withRetry } from "../../utilities/retry.js";
import { awaitWithAbort } from "../../utilities/abort.js";
import { cancelBody, readBoundedBody } from "../../utilities/read-body.js";
import {
  COLLECTOR_RESPONSE_BYTES,
  CollectorRequestError,
  assertCollectorFailureMessage,
  batchReplySchema,
  claimReplySchema,
  controlReplySchema,
  failureReplySchema,
  decodeCollectorJson,
  parseCollectorToken,
} from "./protocol.js";

export function collectorBaseUrl(value: string): string {
  const base = new URL(value);
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash)
    throw new Error("Collector requires an HTTPS base URL without credentials, query or fragment.");
  return base.href.replace(/\/+$/, "");
}

/** HTTP delivery only; admission and ordered execution state belong to the client. */
export function createCollectorTransport(options: {
  readonly baseUrl: string;
  readonly launchId: string;
  readonly workerId: string;
  readonly token: string;
  readonly fetch?: typeof fetch;
  readonly signal?: AbortSignal;
}) {
  const { baseUrl, launchId, workerId, token, signal: callerSignal } = options;
  if (!parseCollectorToken(token)) throw new Error("Invalid collector credential.");
  const endpoint = `${collectorBaseUrl(baseUrl)}/v1/launches/${encodeURIComponent(launchId)}`;
  const transport = options.fetch ?? fetch;

  async function request<T>(
    operation: "admit" | "batches" | "failure" | "control",
    body: Uint8Array,
    reply: WireSchema<T>
  ): Promise<T> {
    const bytes = await withRetry(
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
          const response = await awaitWithAbort(
            pending.then((response) => {
              if (signal.aborted) cancelBody(response.body);
              return response;
            }),
            signal,
            "Collector request"
          );
          if (!response.ok) {
            cancelBody(response.body);
            throw new CollectorRequestError(
              response.status,
              response.status === 408 || response.status === 429 || response.status >= 500
            );
          }
          if (
            response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
            "application/json"
          ) {
            cancelBody(response.body);
            throw new CollectorRequestError(response.status, false);
          }
          return await readBoundedBody(response.body, COLLECTOR_RESPONSE_BYTES, signal);
        } catch (cause) {
          if (cause instanceof CollectorRequestError) throw cause;
          // Never expose provider, body or URL diagnostics through delivery errors.
          throw new CollectorRequestError(
            0,
            cause instanceof TypeError || controller.signal.aborted
          );
        } finally {
          clearTimeout(timer);
        }
      },
      {
        maxAttempts: operation === "admit" ? 1 : 4,
        baseDelayMs: 100,
        signal: callerSignal,
        shouldRetry: (cause) => cause instanceof CollectorRequestError && cause.retryable,
      }
    );
    return decodeCollectorJson(bytes, reply);
  }

  return {
    cancellationRequested(attemptId: string) {
      assertAttemptId(attemptId);
      return request(
        "control",
        new TextEncoder().encode(JSON.stringify({ attemptId })),
        controlReplySchema
      );
    },
    claim: (body: Uint8Array) => request("admit", body, claimReplySchema),
    async append(body: Uint8Array): Promise<AttemptBatchAcknowledgement> {
      try {
        return await request("batches", body, batchReplySchema);
      } catch (cause) {
        if (cause instanceof CollectorRequestError && cause.status === 410)
          return { accepted: false };
        throw cause;
      }
    },
    async reportFailure(input: { readonly attemptId: string; readonly message: string }) {
      const { attemptId, message } = input;
      assertAttemptId(attemptId);
      assertCollectorFailureMessage(message);
      const body = new TextEncoder().encode(
        JSON.stringify({
          attemptId,
          failureId: crypto.randomUUID(),
          message,
        })
      );
      return request("failure", body, failureReplySchema);
    },
  };
}
