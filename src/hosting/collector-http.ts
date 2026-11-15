import type { HostedCollectorStore } from "./collector-store.js";
import { verifyCollectorCredential } from "./collector-credentials.js";
import { HostedAttemptConflict } from "./attempt-store.js";
import { jsonResponse } from "../studio/server/http.js";
import { BodyLimitError, readBoundedBody } from "../utilities/read-body.js";
import { awaitWithAbort } from "../utilities/abort.js";
import {
  COLLECTOR_BATCH_BYTES,
  COLLECTOR_CLAIM_BYTES,
  COLLECTOR_CONTROL_BYTES,
  COLLECTOR_FAILURE_BYTES,
  CollectorAuthorityError,
  CollectorInputError,
  claimSchema,
  controlSchema,
  decodeCollectorJson,
} from "./collector-protocol.js";

/** Separate executor ingress; never mount this as a Studio admin/browser capability. */
export function createHostedCollector(options: {
  readonly store: HostedCollectorStore;
  readonly now?: () => number;
}) {
  const now = options.now ?? Date.now;
  const error = (status: number, code: string, extra: object = {}) =>
    jsonResponse({ code, ...extra }, status);
  return {
    async fetch(request: Request): Promise<Response> {
      const signal = AbortSignal.any([request.signal, AbortSignal.timeout(10_000)]);
      const wait = <T>(pending: Promise<T>) => awaitWithAbort(pending, signal, "Collector request");
      try {
        const url = new URL(request.url);
        const route = /^\/v1\/launches\/([^/]+)\/(admit|batches|failure|control)$/.exec(
          url.pathname
        );
        if (!route || url.search) return error(404, "not_found");
        if (url.protocol !== "https:") return error(400, "https_required");
        let launchId: string;
        try {
          launchId = decodeURIComponent(route[1]!);
        } catch {
          throw new CollectorInputError();
        }
        if (!launchId || launchId.length > 256) throw new CollectorInputError();
        const token = /^Bearer ([a-f0-9]{32}\.[a-f0-9]{64})$/.exec(
          request.headers.get("authorization") ?? ""
        )?.[1];
        if (!token) throw new CollectorAuthorityError();
        const credential = await wait(
          options.store.getCollectorCredential(launchId, token.slice(0, 32))
        );
        if (!credential || !(await wait(verifyCollectorCredential(token, credential, now()))))
          throw new CollectorAuthorityError();
        if (request.method !== "POST") return error(405, "method_not_allowed");
        const workerId = request.headers.get("x-tubeless-worker-id");
        if (!workerId || workerId.length > 256) throw new CollectorInputError();
        if (
          request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
          "application/json"
        )
          return error(415, "json_required");
        const operation = route[2]!;
        const limits: Readonly<Record<string, number>> = {
          admit: COLLECTOR_CLAIM_BYTES,
          batches: COLLECTOR_BATCH_BYTES,
          failure: COLLECTOR_FAILURE_BYTES,
          control: COLLECTOR_CONTROL_BYTES,
        };
        const limit = limits[operation]!;
        const length = request.headers.get("content-length");
        if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit))
          throw new CollectorInputError(413);
        const bytes = await readBoundedBody(request.body, limit, signal);
        if (operation === "control") {
          const control = decodeCollectorJson(bytes, controlSchema);
          if (control.attemptId !== credential.attemptId) throw new CollectorAuthorityError();
          return jsonResponse({
            cancelRequested: await wait(
              options.store.collectorCancellationRequested(credential, workerId)
            ),
          });
        }
        if (operation === "admit") {
          const claim = decodeCollectorJson(bytes, claimSchema);
          if (claim.attemptId !== credential.attemptId) throw new CollectorAuthorityError();
          return jsonResponse({
            admitted: await wait(
              options.store.claimCollectorAttempt(credential, workerId, claim.deploymentId)
            ),
          });
        }
        if (operation === "batches") {
          const ack = await wait(options.store.acceptCollectorBatch(credential, workerId, bytes));
          return ack.accepted ? jsonResponse(ack) : error(410, "attempt_closed");
        }
        return jsonResponse({
          recorded: await wait(options.store.reportCollectorFailure(credential, workerId, bytes)),
        });
      } catch (cause) {
        if (cause instanceof CollectorAuthorityError) return error(401, "unauthorized");
        if (cause instanceof CollectorInputError) return error(cause.status, "invalid_request");
        if (cause instanceof BodyLimitError) return error(413, "body_too_large");
        if (cause instanceof HostedAttemptConflict) {
          if (cause.code === "ownership") return error(401, "unauthorized");
          return error(
            409,
            `${cause.code}_conflict`,
            cause.expectedSequence === undefined ? {} : { expectedSequence: cause.expectedSequence }
          );
        }
        if (signal.aborted || (cause instanceof DOMException && cause.name === "TimeoutError"))
          return error(408, "request_timeout");
        // Never echo/log storage, token, event or transport diagnostics onto this write surface.
        return error(503, "collector_unavailable");
      } finally {
        if (!request.body?.locked) void request.body?.cancel().catch(() => {});
      }
    },
  };
}
