import { expect, it } from "vitest";
import { runOutputObservationExample } from "../../../examples/step-output-observation.js";

it("captures the recipe's raw value separately from its transformed public result", async () => {
  const { run, records, rawOutputs, restoredRun } = await runOutputObservationExample();
  expect(run).toMatchObject({ status: "completed", value: 5 });
  expect(restoredRun).toMatchObject({
    status: "completed",
    value: 5,
    steps: [{ outputSource: "supplied" }],
  });
  expect(rawOutputs).toEqual(["hello"]);
  expect(records).toMatchObject([
    {
      stepId: "count",
      origin: "handler",
      runId: run.runId,
      definitionIdentity: { implementationVersion: "text-length-v1" },
    },
  ]);
});
