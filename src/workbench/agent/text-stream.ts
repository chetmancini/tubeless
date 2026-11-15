import type { AgentTextOptions } from "../../agent/agent.js";
import { safeTerminalLog } from "../../reporter/terminal-text.js";
import { writeCliChunk, type WorkbenchCliIo } from "../workbench-shared.js";

/** Incremental commentary uses stderr; stdout keeps the validated final answer. */
export function createTerminalTextStream(io: WorkbenchCliIo): AgentTextOptions {
  const active = new Set<string>();
  return {
    async write(event) {
      if (event.kind === "delta") {
        const prefix = active.has(event.streamId) ? "" : "\nassistant · ";
        active.add(event.streamId);
        await writeCliChunk(io.stderr, prefix + safeTerminalLog(event.text), io.signal);
      } else if (active.delete(event.streamId)) {
        const ending = event.status === "completed" ? "\n" : "\n[assistant text interrupted]\n";
        // Closing an interrupted line is best effort, including after launch cancellation.
        if (io.signal?.aborted) io.stderr.write(ending);
        else await writeCliChunk(io.stderr, ending, io.signal);
      }
    },
  };
}
