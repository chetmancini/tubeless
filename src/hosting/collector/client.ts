import type { PipelineTraceEvent } from "../../tracing/tracing.js";
import type { AttemptBatchAcknowledgement } from "../attempt/store.js";
import { assertAttemptId } from "../attempt/store.js";
import { assertCollectorFailureMessage, CollectorRequestError } from "./protocol.js";
import { decodeAttemptEvent, encodeAttemptBatches } from "../attempt/batch.js";
import { createCollectorTransport } from "./transport.js";

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
  const { launchId, attemptId, deploymentId } = options;
  for (const id of [launchId, attemptId, deploymentId]) assertAttemptId(id);
  const workerId = crypto.randomUUID();
  const transport = createCollectorTransport({ ...options, workerId });
  const encoder = new TextEncoder();
  let phase: "new" | "active" | "ending" | "closed" = "new";
  let sequence = 0;
  let tail: Promise<unknown> = Promise.resolve();

  return {
    workerId,
    async claim(): Promise<boolean> {
      if (phase !== "new") return false;
      // Consume the request before waiting; an unconfirmed grant must stay closed.
      phase = "closed";
      const { admitted } = await transport.claim(
        encoder.encode(JSON.stringify({ attemptId, deploymentId }))
      );
      if (admitted) phase = "active";
      return admitted;
    },
    append(events: readonly PipelineTraceEvent[]): Promise<AttemptBatchAcknowledgement> {
      if (phase !== "active") return Promise.reject(new CollectorRequestError(0, false));
      // Own JSON snapshots before queueing, so callers cannot change a pending request.
      let owned: PipelineTraceEvent[];
      try {
        owned = events.map((event) => decodeAttemptEvent(JSON.parse(JSON.stringify(event))));
      } catch {
        return Promise.reject(new CollectorRequestError(0, false));
      }
      const delivery = tail.then(async (): Promise<AttemptBatchAcknowledgement> => {
        // An ending client still drains previously queued writes. A closed attempt cannot.
        if (phase === "closed") throw new CollectorRequestError(0, false);
        const batches = encodeAttemptBatches(attemptId, sequence, owned);
        let acknowledgement: AttemptBatchAcknowledgement = { accepted: false };
        for (const bytes of batches) {
          acknowledgement = await transport.append(bytes);
          if (!acknowledgement.accepted) {
            phase = "closed";
            return acknowledgement;
          }
          sequence++;
        }
        return acknowledgement;
      });
      tail = delivery;
      // oxlint-disable-next-line landmines/no-silent-catch -- Keep the rejection on the returned promise and on the queue.
      void delivery.catch(() => {});
      return delivery;
    },
    async reportFailure(message: string): Promise<boolean> {
      if (phase !== "active") throw new CollectorRequestError(0, false);
      assertCollectorFailureMessage(message);
      phase = "ending";
      await tail.catch(() => {});
      try {
        return (await transport.reportFailure({ attemptId, message })).recorded;
      } finally {
        phase = "closed";
      }
    },
  };
}
