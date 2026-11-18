import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createRecoveryPipeline,
  recoveryInputIdentity,
} from "../../examples/step-output-recovery.js";
import { openRecoveryStore } from "../../examples/recovery/file-output-store.js";

const [directory, mode] = process.argv.slice(2);
if (!directory || !["fail", "resume", "baseline", "crash", "reconcile"].includes(mode))
  throw new Error("Invalid fixture arguments");
const input = { seed: 10 };
const calls: string[] = [];
const pipeline = createRecoveryPipeline(async (stepId, value) => {
  calls.push(stepId);
  if (mode === "fail" && stepId === "step-7") throw new Error("Injected worker failure");
  const result = String(value + 1);
  if (stepId === "step-7" && (mode === "crash" || mode === "reconcile")) {
    await appendFile(join(directory, "effect-attempts"), "attempt\n");
    try {
      // Stand in for an external service's create-once business idempotency key.
      await writeFile(join(directory, "worker-job-42-step-7.receipt"), result, { flag: "wx" });
      await appendFile(join(directory, "effect-commits"), "commit\n");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EEXIST")
        return readFile(join(directory, "worker-job-42-step-7.receipt"), "utf8");
      throw error;
    }
  }
  return result;
});
const store = await openRecoveryStore(directory, pipeline, {
  executionId: "worker-job-42",
  inputIdentity: recoveryInputIdentity(input),
});
const run = await pipeline.run(
  input,
  mode === "baseline"
    ? {}
    : {
        outputObserver: {
          ...store.observer,
          write(record, context) {
            if (mode === "crash" && record.stepId === "step-7") process.exit(91);
            return store.observer.write(record, context);
          },
        },
        suppliedOutputs: mode === "resume" || mode === "reconcile" ? await store.load() : undefined,
      }
);
process.stdout.write(JSON.stringify({ run, calls }));
