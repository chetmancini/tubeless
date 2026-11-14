import { mkdir, open } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  decodeAgentTranscriptRecord,
  type AgentTranscriptRecord,
} from "../tracing/agent-transcript.js";

/** An application-owned transcript destination. Close it after all agents have settled. */
export interface NdjsonAgentTranscriptWriter {
  write(record: AgentTranscriptRecord): Promise<void>;
  close(): Promise<void>;
}

/** Append validated records to an explicit NDJSON path; newly created files use mode 0600. */
export async function openNdjsonAgentTranscriptWriter(
  filename: string
): Promise<NdjsonAgentTranscriptWriter> {
  const target = resolve(filename);
  await mkdir(dirname(target), { recursive: true });
  const handle = await open(target, "a", 0o600);
  let pending = Promise.resolve();
  let closed = false;
  let closing: Promise<void> | undefined;
  return {
    write(record) {
      if (closed) return Promise.reject(new Error("Cannot write a closed transcript destination"));
      let line: string;
      try {
        line = JSON.stringify(decodeAgentTranscriptRecord(record)) + "\n";
      } catch (error) {
        return Promise.reject(error);
      }
      pending = pending.then(() => handle.writeFile(line));
      return pending;
    },
    close() {
      closed = true;
      closing ??= (async () => {
        try {
          await pending;
        } finally {
          await handle.close();
        }
      })();
      return closing;
    },
  };
}
