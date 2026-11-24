import { expect, it } from "vitest";
import { createSteps, definePipeline } from "../core/pipeline.js";
import { decodeRunnerBatch, encodeAttemptBatches } from "./attempt/batch.js";
import { decodeRunnerReport, parseRunnerManifest, runnerChildControls } from "./runner-protocol.js";
import type { PipelineTraceEvent } from "../tracing/tracing.js";

it("round-trips authored IDs, selectors, step output metadata and a finalized void", async () => {
  const { step } = createSteps();
  const read = step("read/input", { run: () => ({ nested: [false, 0, "", null] }) });
  const publish = step("publish/report", { dependsOn: [read], run: () => undefined });
  const pipeline = definePipeline({
    id: "child/作業",
    implementationVersion: "v1",
    steps: [read, publish],
    targets: [publish],
  });
  const options = { targets: ["publish/report"] } as const;
  expect(runnerChildControls(options)).toMatchObject(options);
  expect(runnerChildControls({ stepIds: ["publish/report"] }).stepIds).toEqual(["publish/report"]);
  const events: PipelineTraceEvent[] = [];
  const run = await pipeline.run({}, options, {
    parentRunId: "parent",
    tracing: {
      exporter: {
        export(event) {
          events.push(event);
        },
      },
    },
  });
  expect(run).toMatchObject({ status: "completed", finalized: true });
  const report = decodeRunnerReport(JSON.parse(JSON.stringify(run)));
  expect(report).toStrictEqual(run);
  expect(Object.hasOwn(report, "value")).toBe(true);
  const withOutputSource = {
    ...run,
    steps: run.steps.map((step) => ({ ...step, outputSource: "cache" })),
  };
  expect(decodeRunnerReport(JSON.parse(JSON.stringify(withOutputSource)))).toEqual(
    withOutputSource
  );
  const withValue = { ...run, value: { nested: [false, 0, "", null] } };
  expect(decodeRunnerReport(JSON.parse(JSON.stringify(withValue)))).toEqual(withValue);
  expect(
    parseRunnerManifest({ [pipeline.id]: run.definitionIdentity!.definitionId }).has(pipeline.id)
  ).toBe(true);
  const [body] = encodeAttemptBatches("claim", 0, events);
  const batch = await decodeRunnerBatch(body);
  expect(batch.events.every(({ pipelineId }) => pipelineId === pipeline.id)).toBe(true);
});
