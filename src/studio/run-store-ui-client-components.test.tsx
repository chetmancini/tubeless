import { StepArtifacts } from "./run-store-ui-artifacts.js";
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

  it("shows artifact lineage and escapes metadata without making URIs executable", () => {
    const root = run({
      steps: [
        {
          id: "save",
          status: "completed",
          artifacts: [
            {
              operation: "reuse",
              preview: true,
              attemptId: "attempt",
              timestampMs: 1,
              artifact: {
                id: "<model>",
                uri: "javascript:alert(1)",
                version: "v2",
                metadata: { tag: "<script>" },
              },
            },
          ],
        },
      ],
    });
    const index = createStudioRunIndex([root]);
    const markup = renderToString(
      <RunsView
        canCancel={false}
        cancelling={false}
        liveRunIds={[]}
        nowMs={2000}
        onCancel={() => {}}
        onSelect={() => {}}
        roots={index.roots}
        runIndex={index}
        selectedRun={root}
        selectedRunId={root.runId}
        totalRunCount={1}
      />
    );
    expect(markup).toContain("Preview reuse: &lt;model>");
    expect(markup).toContain("v2");
    expect(markup).not.toContain("<script>");
    expect(markup).not.toContain('href="javascript:');
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

  it.each([0, 1, 3, 5])("summarizes %s running steps without completed names", (count) => {
    const root = run({
      steps: [
        { id: "done", name: "Completed task", status: "completed" },
        ...Array.from({ length: count }, (_, index) => ({
          id: `step-${index}`,
          name: index === 1 ? undefined : `Task ${index}`,
          status: "running" as const,
          progress: { completed: 1, message: "Loading records" },
        })),
      ],
    });
    const index = createStudioRunIndex([root]);
    const markup = renderToString(
      <RunsView
        canCancel={false}
        cancelling={false}
        liveRunIds={[root.runId]}
        nowMs={2_000}
        onCancel={() => {}}
        onSelect={() => {}}
        roots={index.roots}
        runIndex={index}
        selectedRun={null}
        selectedRunId={null}
        totalRunCount={1}
      />
    );
    expect(markup).not.toContain("Completed task");
    if (count > 1) {
      expect(markup).toContain(`${count} steps running`);
      expect(markup).toContain(`Task 0, step-1, Task 2${count > 3 ? " +2 more" : ""}`);
      expect(markup).not.toContain("Task 3");
      expect(markup).not.toContain("Loading records");
    } else {
      expect(markup).toContain(count === 1 ? "Task 0" : "Starting");
      expect(markup).toContain(count === 1 ? "Loading records" : "Execution in progress");
    }
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

it.each(["completed", "failed", "cancelled"])("renders %s with override provenance", (status) => {
  const markup = renderToString(<Status value={status} outputSource="override" />);
  expect(markup).toContain(`${status} (overridden)`);
  expect(markup).toContain(`status ${status}`);
});

it.each(["completed", "failed", "cancelled"])("renders %s with cache provenance", (status) => {
  const markup = renderToString(<Status value={status} outputSource="cache" />);
  expect(markup).toContain("(cached)");
});

it("distinguishes cached outputs from application artifacts and offers filters", () => {
  const markup = renderToString(
    <StepArtifacts
      stepId="count"
      artifacts={[
        {
          operation: "reuse",
          preview: false,
          timestampMs: 2000,
          attemptId: "cache",
          artifact: {
            id: "cache-id",
            uri: "file:///tmp/count.cache",
            byteSize: 42,
            metadata: {
              tubelessCache: { implementationVersion: "v1", createdAtMs: 1000, ageMs: 1000 },
            },
          },
        },
        {
          operation: "write",
          preview: false,
          timestampMs: 2000,
          attemptId: "app",
          artifact: { id: "application" },
        },
      ]}
    />
  );
  expect(markup).toContain("Cached output reuse");
  expect(markup).toContain("Created: 1970-01-01T00:00:01.000Z");
  expect(markup).toContain("Age at reuse: 1000 ms");
  expect(markup).toContain("Location: file:///tmp/count.cache");
  expect(markup).toContain("Size: 42 bytes");
  expect(markup).toContain("Application artifacts");
  expect(markup).toContain("Artifact write: application");
  expect(markup).toContain("current cache availability is not checked");
});
