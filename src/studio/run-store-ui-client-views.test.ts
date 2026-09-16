import { describe, expect, it } from "vitest";
import { RUN_MODEL_VERSION } from "../core/pipeline.js";
import type { PipelinePlan } from "../core/pipeline.js";
import type { StoredPipelineRun } from "../run-store/run-store.js";
import { createStudioRunIndex } from "./run-store-ui-client-model.js";
import type { PipelineRunStudioCommand } from "./run-store-ui-protocol.js";
import {
  renderCommandFormFields,
  renderPipelinesView,
  renderPlanView,
  renderRunsView,
} from "./run-store-ui-client-views.js";

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

describe("Studio views", () => {
  it("renders form markup from descriptors without a DOM", () => {
    const markup = renderCommandFormFields(command);
    expect(markup).toContain("Display Name");
    expect(markup).toContain("A &quot;name&quot;");
    expect(markup).toContain("required");
  });

  it("escapes command data in catalog markup", () => {
    expect(renderPipelinesView([command])).toContain("A &lt;checked&gt; pipeline");
  });

  it("renders run hierarchy from explicit data only", () => {
    const root = run();
    const index = createStudioRunIndex([root]);
    const markup = renderRunsView({
      canCancel: true,
      cancelling: false,
      liveRunIds: [root.runId],
      nowMs: 2_000,
      roots: index.roots,
      runIndex: index,
      selectedRun: root,
      selectedRunId: root.runId,
      totalRunCount: 1,
    });
    expect(markup).toContain("Pipeline runs");
    expect(markup).toContain("Cancel run");
    expect(markup).toContain("1s ago");
  });

  it("renders plan markup without reading controller state", () => {
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
    expect(renderPlanView(plan)).toContain("1 of 1 steps will run · dry run");
    expect(renderPlanView(plan)).toContain("</small>");
  });
});
