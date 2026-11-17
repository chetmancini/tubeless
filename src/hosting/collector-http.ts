import type { CollectorAuthorization, HostedCollectorStore } from "./collector-store.js";
import { verifyCollectorCredential } from "./collector-credentials.js";
import { HostedAttemptConflict, isAttemptId } from "./attempt-store.js";
import { jsonResponse } from "../utilities/http-response.js";
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
  parseCollectorToken,
} from "./collector-protocol.js";

interface CollectorOperation {
  readonly limit: number;
  handle(body: Uint8Array, authority: CollectorAuthorization, workerId: string): Promise<Response>;
}

/** Separate executor ingress; never mount this as a Studio admin/browser capability. */
export function createHostedCollector(options: {
  readonly store: Omit<HostedCollectorStore, "provisionCollectorAttempt">;
  readonly now?: () => number;
}) {
  const now = options.now ?? Date.now;
  const error = (status: number, code: string, extra: object = {}) =>
    jsonResponse({ code, ...extra }, status);
  const operations = new Map(
    Object.entries<CollectorOperation>({
      admit: {
        limit: COLLECTOR_CLAIM_BYTES,
        async handle(body, authority, workerId) {
          const claim = decodeCollectorJson(body, claimSchema);
          if (claim.attemptId !== authority.attemptId) throw new CollectorAuthorityError();
          return jsonResponse({
            admitted: await options.store.claimCollectorAttempt(
              authority,
              workerId,
              claim.deploymentId
            ),
          });
        },
      },
      control: {
        limit: COLLECTOR_CONTROL_BYTES,
        async handle(body, authority, workerId) {
          const control = decodeCollectorJson(body, controlSchema);
          if (control.attemptId !== authority.attemptId) throw new CollectorAuthorityError();
          return jsonResponse({
            cancelRequested: await options.store.collectorCancellationRequested(
              authority,
              workerId
            ),
          });
        },
      },
      batches: {
        limit: COLLECTOR_BATCH_BYTES,
        async handle(body, authority, workerId) {
          const ack = await options.store.acceptCollectorBatch(authority, workerId, body);
          return ack.accepted ? jsonResponse(ack) : error(410, "attempt_closed");
        },
      },
      failure: {
        limit: COLLECTOR_FAILURE_BYTES,
        async handle(body, authority, workerId) {
          return jsonResponse({
            recorded: await options.store.reportCollectorFailure(authority, workerId, body),
          });
        },
      },
    })
  );
  return {
    async fetch(request: Request): Promise<Response> {
      const signal = AbortSignal.any([request.signal, AbortSignal.timeout(10_000)]);
      const wait = <T>(pending: Promise<T>) => awaitWithAbort(pending, signal, "Collector request");
      try {
        const url = new URL(request.url);
        const route = /^\/v1\/launches\/([^/]+)\/([^/]+)$/.exec(url.pathname);
        const operation = route && operations.get(route[2]);
        if (!route || !operation || url.search) return error(404, "not_found");
        if (url.protocol !== "https:") return error(400, "https_required");
        let launchId: string;
        try {
          launchId = decodeURIComponent(route[1]);
        } catch {
          throw new CollectorInputError();
        }
        if (!isAttemptId(launchId)) throw new CollectorInputError();
        const authorization = request.headers.get("authorization");
        const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined;
        const parsedToken = parseCollectorToken(token);
        if (!token || !parsedToken) throw new CollectorAuthorityError();
        const credential = await wait(
          options.store.getCollectorCredential(launchId, parsedToken.credentialId)
        );
        if (!credential || !(await wait(verifyCollectorCredential(token, credential, now()))))
          throw new CollectorAuthorityError();
        if (request.method !== "POST") return error(405, "method_not_allowed");
        const workerId = request.headers.get("x-tubeless-worker-id");
        if (!isAttemptId(workerId)) throw new CollectorInputError();
        if (
          request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
          "application/json"
        )
          return error(415, "json_required");
        const length = request.headers.get("content-length");
        if (length !== null && (!/^\d+$/.test(length) || Number(length) > operation.limit))
          throw new CollectorInputError(413);
        const bytes = await readBoundedBody(request.body, operation.limit, signal);
        return await wait(operation.handle(bytes, credential, workerId));
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
