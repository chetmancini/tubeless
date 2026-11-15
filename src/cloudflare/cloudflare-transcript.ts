import {
  decodeAgentTranscriptRecord,
  type AgentTranscriptRecord,
} from "../tracing/agent-transcript.js";
import { awaitWithAbort } from "../utilities/abort.js";
import { withRetry } from "../utilities/retry.js";

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
        await withRetry(
          async () => {
            const { accepted } = await awaitWithAbort(
              Promise.resolve().then(() => studio().appendTranscript(record)),
              controller.signal,
              "Transcript delivery"
            );
            if (!accepted) throw new Error("Transcript run is absent from history");
          },
          { maxAttempts: 5, baseDelayMs: 250, signal: controller.signal }
        );
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}
