import type { AgentTextOptions } from "../../agent/agent.js";
import { createTerminalLogSanitizer } from "../../reporter/terminal-text.js";
import { writeCliChunk, type WorkbenchCliIo } from "../workbench-shared.js";

/** Incremental commentary uses stderr; stdout keeps the validated final answer. */
export function createTerminalTextStream(io: WorkbenchCliIo): AgentTextOptions {
  const active = new Map<string, ReturnType<typeof createTerminalLogSanitizer>>();
  return {
    async write(event, signal) {
      if (event.kind === "delta") {
        const previous = active.get(event.streamId);
        const sanitize = previous ?? createTerminalLogSanitizer();
        active.set(event.streamId, sanitize);
        const output = (previous ? "" : "\nassistant · ") + sanitize(event.text);
        if (output) await writeCliChunk(io.stderr, output, signal);
      } else if (active.delete(event.streamId)) {
        const ending = event.status === "completed" ? "\n" : "\n[assistant text interrupted]\n";
        // Closing an interrupted line is best effort, including after launch cancellation.
        if (signal.aborted) io.stderr.write(ending);
        else await writeCliChunk(io.stderr, ending, signal);
      }
    },
  };
}
