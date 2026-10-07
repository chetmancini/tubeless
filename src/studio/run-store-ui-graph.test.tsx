import { renderToString } from "preact-render-to-string";
import { describe, expect, it } from "vitest";
import { RUN_MODEL_VERSION } from "../core/pipeline.js";
import { createRunHistoryIndex, summarizeRun } from "../run-store/run-history.js";
import type { StoredPipelineRun, StoredPipelineStep } from "../run-store/run-store.js";
import { RunGraph } from "./run-store-ui-graph.js";

function run(overrides: Partial<StoredPipelineRun> = {}): StoredPipelineRun {
  return {
    dryRun: false,
    eventCount: 1,
    logCount: 0,
    logs: [],
    pipelineId: "parent",
    runId: "root",
    startedAtMs: 1_000,
    status: "running",
    steps: [],
    version: RUN_MODEL_VERSION,
    ...overrides,
  };
}

function step(
  id: string,
  status: StoredPipelineStep["status"],
  overrides: Partial<StoredPipelineStep> = {}
): StoredPipelineStep {
  return {
    id,
    status,
    dependencies: [],
    optionalDependencies: [],
    skipAfterFailureOf: [],
    ...overrides,
  };
}

/** Render the graph for `root` with its direct children attributed by the history index. */
function graph(root: StoredPipelineRun, children: readonly StoredPipelineRun[] = []) {
  const index = createRunHistoryIndex([root, ...children]);
  const markup = renderToString(
    <RunGraph
      detail={{
        run: root,
        ancestors: [],
        children: index.childrenOf(root.runId).map((child) => summarizeRun(child, index)),
        descendantCount: index.descendantCount(root.runId),
      }}
      onOpenRun={() => {}}
    />
  );
  const count = (needle: string) => markup.split(needle).length - 1;
  return { markup, count };
}

describe("RunGraph", () => {
  it("draws step states and edge states from planned dependencies", () => {
    const { markup } = graph(
      run({
        steps: [
          step("load", "completed"),
          step("transform", "running", { dependencies: ["load"] }),
          step("report", "planned", { dependencies: ["transform"] }),
          step("check", "failed"),
          step("alert", "skipped", { skipAfterFailureOf: ["check"] }),
          step("stop", "cancelled", { optionalDependencies: ["check"] }),
        ],
      })
    );
    for (const [id, status] of [
      ["load", "completed"],
      ["transform", "running"],
      ["report", "planned"],
      ["check", "failed"],
      ["alert", "skipped"],
      ["stop", "cancelled"],
    ]) {
      expect(markup).toContain(`aria-label="${id}: ${status}"`);
      expect(markup).toContain(`graph-node step ${status}`);
    }
    expect(markup).toContain('class="graph-edge-group input active"');
    expect(markup).toContain('class="graph-edge-group input candidate"');
    expect(markup).toContain('class="graph-edge-group gate tripped"');
    expect(markup).toContain('class="graph-edge-group optional blocked"');
    // Only an edge feeding a running step animates its flow.
    expect(markup.split('class="graph-edge-flow"').length - 1).toBe(1);
  });

  it("trips gates on cancellation and never animates a missing optional input", () => {
    const { markup, count } = graph(
      run({
        steps: [
          step("stopped", "cancelled"),
          step("broken", "failed"),
          step("gated", "skipped", { skipAfterFailureOf: ["stopped"] }),
          step("both", "skipped", { dependencies: ["broken"], skipAfterFailureOf: ["broken"] }),
          step("fallback", "running", { optionalDependencies: ["broken"] }),
        ],
      })
    );
    // A cancelled gate source and a failed source that is both input and gate trip the gate.
    expect(count('class="graph-edge-group gate tripped"')).toBe(2);
    expect(markup).toContain('class="graph-edge-group optional blocked"');
    expect(count('class="graph-edge-flow"')).toBe(0);
  });

  it("expands a running fan-out into its attributed child runs", () => {
    const root = run({
      steps: [
        step("fanout", "running", {
          nestedPipeline: {
            mode: "for-each",
            pipelineId: "child",
            stepCount: 1,
            stepIds: ["work"],
          },
        }),
        step("after", "planned", { dependencies: ["fanout"] }),
      ],
    });
    const child = (itemKey: string, status: StoredPipelineRun["status"]) =>
      run({ runId: `child-${itemKey}`, parentRunId: "root", pipelineId: "child", itemKey, status });
    const { markup, count } = graph(root, [
      child("first", "completed"),
      child("second", "running"),
    ]);
    expect(markup).toContain('class="graph-expansion"');
    expect(count("graph-node run ")).toBe(2);
    expect(markup).toContain('aria-label="first (child): completed"');
    expect(markup).toContain('aria-label="second (child): running"');
    expect(markup).toContain('aria-label="Collapse fanout"');
  });

  it("keeps finished fan-outs collapsed behind a count badge", () => {
    const root = run({
      status: "completed",
      steps: [
        step("fanout", "completed", {
          nestedPipeline: {
            mode: "for-each",
            pipelineId: "child",
            stepCount: 1,
            stepIds: ["work"],
          },
        }),
      ],
    });
    const { markup } = graph(root, [
      run({
        runId: "child-a",
        parentRunId: "root",
        pipelineId: "child",
        itemKey: "a",
        status: "completed",
      }),
    ]);
    expect(markup).not.toContain('class="graph-expansion"');
    expect(markup).toContain('aria-label="Expand fanout"');
  });

  it("labels dynamic agent tool calls by tool without duplicating calls that started runs", () => {
    const root = run({
      pipelineId: "agent/turn",
      agentTurn: {
        agentRunId: "agent",
        index: 1,
        calls: [
          {
            agentRunId: "agent",
            turn: 1,
            callId: "c1",
            tool: "search",
            parentAttemptId: "attempt",
          },
          {
            agentRunId: "agent",
            turn: 1,
            callId: "c3",
            tool: "summarize",
            parentAttemptId: "attempt",
          },
        ],
      },
      steps: [
        step("decide", "completed"),
        step("calls", "running", {
          dependencies: ["decide"],
          attempt: { attemptId: "attempt", retries: [], startedAtMs: 1_000, status: "running" },
          progress: {
            completed: 1,
            total: 3,
            details: [
              { id: "c1", status: "completed" },
              { id: "c2", status: "failed" },
              { id: "c3", status: "running" },
            ],
          },
        }),
      ],
    });
    const { markup, count } = graph(root, [
      run({
        runId: "tool-run",
        parentRunId: "root",
        pipelineId: "agent/tool/summarize",
        itemKey: "c3",
        agentCall: {
          agentRunId: "agent",
          turn: 1,
          callId: "c3",
          tool: "summarize",
          parentAttemptId: "attempt",
        },
      }),
    ]);
    expect(markup).toContain('aria-label="search: completed"');
    expect(markup).toContain('aria-label="c2: failed"');
    expect(markup).toContain('aria-label="summarize (agent/tool/summarize): running"');
    expect(count("graph-node item ")).toBe(2);
    expect(count("graph-node run ")).toBe(1);
  });
});
