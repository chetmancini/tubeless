import { renderToString } from "preact-render-to-string";
import { describe, expect, it } from "vitest";
import { RUN_MODEL_VERSION, type PipelinePlan } from "../core/pipeline.js";
import type { StoredPipelineRun } from "../run-store/run-store.js";
import {
  CommandFields,
  createStudioRunIndex,
  isoTime,
  PipelinesView,
  PlanView,
  RunsView,
  Status,
} from "./run-store-ui-client.js";
import type { PipelineRunStudioCommand } from "./run-store-ui-protocol.js";

const command: PipelineRunStudioCommand = {
  canPlan: true,
  description: "A <checked> pipeline",
  id: "fixture",
  name: "Fixture",
  parameters: [
    {
      description: 'A "name"',
      flag: "--name",
      key: "displayName",
      multiple: false,
      positional: false,
      required: true,
      type: "string",
    },
  ],
};

function run(overrides: Partial<StoredPipelineRun> = {}): StoredPipelineRun {
  return {
    dryRun: false,
    eventCount: 1,
    logCount: 0,
    logs: [],
    pipelineId: "fixture",
    runId: "run-1",
    startedAtMs: 1_000,
    status: "running",
    steps: [],
    version: RUN_MODEL_VERSION,
    ...overrides,
  };
}

describe("Studio components", () => {
  it("renders form controls from descriptors", () => {
    const markup = renderToString(
      <CommandFields command={command} values={[[""]]} onChange={() => {}} />
    );
    expect(markup).toContain("Display Name");
    expect(markup).toContain("A &quot;name&quot;");
    expect(markup).toContain("required");
  });

  it("escapes command data in the catalog", () => {
    const markup = renderToString(<PipelinesView commands={[command]} onConfigure={() => {}} />);
    expect(markup).toContain("A &lt;checked> pipeline");
    expect(markup).not.toContain("<checked>");
  });

  it("renders run hierarchy from explicit data only", () => {
    const root = run();
    const index = createStudioRunIndex([root]);
    const markup = renderToString(
      <RunsView
        canCancel
        cancelling={false}
        liveRunIds={[root.runId]}
        nowMs={2_000}
        onCancel={() => {}}
        onSelect={() => {}}
        roots={index.roots}
        runIndex={index}
        selectedRun={root}
        selectedRunId={root.runId}
        totalRunCount={1}
      />
    );
    expect(markup).toContain("Pipeline runs");
    expect(markup).toContain("Cancel run");
    expect(markup).toContain("1s ago");
  });

  it("renders plan data without controller state", () => {
    const plan: PipelinePlan = {
      dryRun: true,
      errors: [],
      ok: true,
      pipelineId: "fixture",
      steps: [
        {
          dependencies: [],
          dryRun: "run",
          id: "load",
          optionalDependencies: [],
          runtimeSkipPossible: false,
          selected: true,
          selectionReasons: [{ kind: "exact" }],
          skipAfterFailureOf: [],
        },
      ],
    };
    const markup = renderToString(<PlanView plan={plan} />);
    expect(markup).toContain("1 of 1 steps will run · dry run");
    expect(markup).toContain("</small>");
  });

  it("escapes status labels and rejects invalid dates", () => {
    const markup = renderToString(<Status value={'failed"><script>'} />);
    expect(markup).toContain("&lt;script>");
    expect(markup).not.toContain("<script>");
    expect(isoTime(Number.POSITIVE_INFINITY)).toBe("");
  });
});
