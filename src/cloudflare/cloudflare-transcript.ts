import {
  decodeAgentTranscriptRecord,
  type AgentTranscriptRecord,
} from "../tracing/agent-transcript.js";
import { abortableSleep, awaitWithAbort } from "../utilities/abort.js";

/** Trusted Studio Durable Object capability; keep this binding on the server. */
export interface CloudflareTranscriptIngest {
  /** False until the matching structural start is recorded. Identical records are idempotent. */
  appendTranscript(record: AgentTranscriptRecord): Promise<{ readonly accepted: boolean }>;
}

/** An explicit agent sink. Each delivery makes at most five attempts within five seconds. */
export function createCloudflareAgentTranscriptWriter(studio: () => CloudflareTranscriptIngest): {
  write(record: AgentTranscriptRecord): Promise<void>;
} {
  return {
    async write(value) {
      const record = decodeAgentTranscriptRecord(value);
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(new Error("Transcript delivery exceeded its deadline")),
        5_000
      );
      try {
        for (let attempt = 0; ; attempt++) {
          try {
            if (
              (
                await awaitWithAbort(
                  Promise.resolve().then(() => studio().appendTranscript(record)),
                  controller.signal,
                  "Transcript delivery"
                )
              ).accepted
            )
              return;
          } catch (error) {
            if (attempt === 4 || controller.signal.aborted) throw error;
          }
          if (attempt === 4) throw new Error("Transcript run is absent from history");
          await abortableSleep(250 * 2 ** attempt, controller.signal, "Transcript delivery");
        }
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}
