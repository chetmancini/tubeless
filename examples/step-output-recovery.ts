import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { createSteps, definePipeline, type StandardSchemaV1 } from "tubeless";
import { openRecoveryStore } from "./recovery/file-output-store.js";

export interface RecoveryInput {
  seed: number;
}

const inputSchema: StandardSchemaV1<RecoveryInput, RecoveryInput> = {
  "~standard": {
    version: 1,
    vendor: "recovery-example",
    validate: (value) =>
      value !== null &&
      typeof value === "object" &&
      "seed" in value &&
      typeof value.seed === "number" &&
      Number.isSafeInteger(value.seed)
        ? { value: { seed: value.seed } }
        : { issues: [{ message: "Expected an integer seed" }] },
  },
};
const numericText: StandardSchemaV1<string, number> = {
  "~standard": {
    version: 1,
    vendor: "recovery-example",
    validate: (value) =>
      typeof value === "string" && value.trim() !== "" && Number.isSafeInteger(Number(value))
        ? { value: Number(value) }
        : { issues: [{ message: "Expected integer text" }] },
  },
};

/** Hash the normalized business input, excluding retry attempts and injected test failures. */
export function recoveryInputIdentity(input: RecoveryInput): string {
  return createHash("sha256")
    .update(JSON.stringify([input.seed]))
    .digest("hex");
}

/** Replace performStep with business work; bump the version when its meaning changes. */
export function createRecoveryPipeline(
  performStep: (stepId: string, value: number) => Promise<string>,
  implementationVersion = "arithmetic-v1"
) {
  const { step } = createSteps(inputSchema);
  // These callbacks may perform external work; dry runs must never call them.
  const one = step("step-1", {
    description: "Start the calculation from the business input.",
    dryRun: "skip",
    outputSchema: numericText,
    run: (_inputs, context) => performStep("step-1", context.options.seed),
  });
  const two = step("step-2", {
    description: "Apply arithmetic stage 2 to the previous validated result.",
    dependsOn: [one],
    dryRun: "skip",
    outputSchema: numericText,
    run: ({ "step-1": value }) => performStep("step-2", value),
  });
  const three = step("step-3", {
    description: "Apply arithmetic stage 3 to the previous validated result.",
    dependsOn: [two],
    dryRun: "skip",
    outputSchema: numericText,
    run: ({ "step-2": value }) => performStep("step-3", value),
  });
  const four = step("step-4", {
    description: "Apply arithmetic stage 4 to the previous validated result.",
    dependsOn: [three],
    dryRun: "skip",
    outputSchema: numericText,
    run: ({ "step-3": value }) => performStep("step-4", value),
  });
  const five = step("step-5", {
    description: "Apply arithmetic stage 5 to the previous validated result.",
    dependsOn: [four],
    dryRun: "skip",
    outputSchema: numericText,
    run: ({ "step-4": value }) => performStep("step-5", value),
  });
  const six = step("step-6", {
    description: "Apply arithmetic stage 6 to the previous validated result.",
    dependsOn: [five],
    dryRun: "skip",
    outputSchema: numericText,
    run: ({ "step-5": value }) => performStep("step-6", value),
  });
  const seven = step("step-7", {
    description: "Apply arithmetic stage 7 to the previous validated result.",
    dependsOn: [six],
    dryRun: "skip",
    outputSchema: numericText,
    run: ({ "step-6": value }) => performStep("step-7", value),
  });
  const eight = step("step-8", {
    description: "Apply arithmetic stage 8 to the previous validated result.",
    dependsOn: [seven],
    dryRun: "skip",
    outputSchema: numericText,
    run: ({ "step-7": value }) => performStep("step-8", value),
  });
  const nine = step("step-9", {
    description: "Apply arithmetic stage 9 to the previous validated result.",
    dependsOn: [eight],
    dryRun: "skip",
    outputSchema: numericText,
    run: ({ "step-8": value }) => performStep("step-9", value),
  });
  return definePipeline({
    id: "step-output-recovery",
    implementationVersion,
    steps: [one, two, three, four, five, six, seven, eight, nine],
    finalize: nine,
  });
}

export const RecoveryPipeline = createRecoveryPipeline(async (_stepId, value) => String(value + 1));

/** Create a fresh private execution directory beneath an existing parent. */
export async function runRecoveryExample(parentDirectory: string) {
  const directory = await mkdtemp(join(parentDirectory, "step-outputs-"));
  const input = { seed: 10 };
  const execution = { executionId: "example-job-42", inputIdentity: recoveryInputIdentity(input) };
  const firstCalls: string[] = [];
  const first = createRecoveryPipeline(async (stepId, value) => {
    firstCalls.push(stepId);
    if (stepId === "step-7") throw new Error("Injected failure before step 7 completes");
    return String(value + 1);
  });
  const firstStore = await openRecoveryStore(directory, first, execution);
  const failed = await first.run(input, { outputObserver: firstStore.observer });

  // Recreate both pipeline and host store; retain only files and business execution identity.
  const resumedCalls: string[] = [];
  const fresh = createRecoveryPipeline(async (stepId, value) => {
    resumedCalls.push(stepId);
    return String(value + 1);
  });
  const freshStore = await openRecoveryStore(directory, fresh, execution);
  const resumed = await fresh.run(input, {
    suppliedOutputs: await freshStore.load(),
    outputObserver: freshStore.observer,
  });
  return { directory, failed, resumed, firstCalls, resumedCalls };
}
