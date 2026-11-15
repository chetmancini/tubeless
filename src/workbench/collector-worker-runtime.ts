import { fileURLToPath } from "node:url";
import { runCollectorJob, type CollectorRunResult } from "../hosting/collector-run.js";
import { commandForPipeline, studioDescriptor } from "../hosting/hosting-commands.js";
import { loadPlanSourceModule } from "./pipeline-module.js";
import type {
  CollectorWorkerRequest,
  CollectorWorkerResponse,
  CollectorWorkerStart,
} from "./collector-worker-protocol.js";

if (!process.send) throw new Error("Collector worker requires a private IPC channel.");
const controller = new AbortController();
const send = (message: CollectorWorkerResponse) =>
  new Promise<void>((resolve, reject) => {
    process.send!(message, (error: Error | null) =>
      error ? reject(new Error("Worker supervision channel closed.")) : resolve()
    );
  });
process.on("disconnect", () => controller.abort(new Error("Worker supervision channel closed.")));
let started = false;
process.on("message", (message: CollectorWorkerRequest) => {
  if (message.type === "cancel") {
    controller.abort(new DOMException("Worker cancellation requested.", "AbortError"));
    return;
  }
  if (started) return;
  started = true;
  void execute(message);
});

async function execute(message: CollectorWorkerStart): Promise<void> {
  let result: CollectorRunResult;
  try {
    result = await runCollectorJob({
      ...message,
      controller,
      output: { cwd: process.cwd(), stdout: process.stdout, stderr: process.stderr },
      onClaim: (workerId) => send({ type: "claimed", workerId }),
      async loadCommands() {
        const source = await loadPlanSourceModule(
          fileURLToPath(message.module),
          message.exportName
        );
        const command =
          source.kind === "command"
            ? source.command
            : commandForPipeline(source.pipeline, "directly loaded");
        return new Map([[command.id, { command, descriptor: studioDescriptor(command) }]]);
      },
    });
  } catch {
    result = { status: "unconfirmed" };
  }
  await send({ type: "done", result }).catch(() => {});
  // This entrypoint owns a one-shot process. Exit also stops stray in-process callbacks.
  process.exit(0);
}
