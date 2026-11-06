import { renderToString } from "preact-render-to-string";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSteps, definePipeline } from "tubeless";
import type { StoredDefinitionSummary } from "../../../run-store/run-history.js";
import type { StoredPipelineDefinition } from "../../../run-store/run-store.js";
import type { StudioApi } from "../transport.js";
import { PipelinePage } from "./pipeline.js";
import type { RailPipeline } from "./rail.js";

const resource = vi.hoisted(() => vi.fn());
vi.mock("../resource.js", () => ({ useStudioResource: resource }));

const values = new Map<string, unknown>();
let pending: { key: string; load: () => Promise<unknown> }[];

beforeEach(() => {
  values.clear();
  pending = [];
  resource.mockReset();
  resource.mockImplementation((_owner: object, key: string, load: () => Promise<unknown>) => {
    if (key) pending.push({ key, load });
    return { value: values.get(key) ?? null, loading: true, reload: () => {} };
  });
});

function definition(pipelineId: string, stepId: string): StoredPipelineDefinition {
  return {
    pipelineId,
    activeRuns: 0,
    firstSeenAtMs: 1,
    lastSeenAtMs: 2,
    runCount: 1,
    targetIds: [],
    steps: [
      {
        id: stepId,
        dryRun: "execute",
        dependencies: [],
        optionalDependencies: [],
        skipAfterFailureOf: [],
        runtimeSkipPossible: false,
      },
    ],
  };
}

function renderGraph(
  api: StudioApi,
  pipeline: RailPipeline,
  definitions: readonly StoredDefinitionSummary[]
): string {
  pending = [];
  return renderToString(
    <PipelinePage
      api={api}
      pipeline={pipeline}
      definitions={definitions}
      tab="graph"
      onTab={() => {}}
      runs={[]}
      matchingRunCount={0}
      offset={0}
      onPage={() => {}}
      nowMs={0}
      onOpenRun={() => {}}
    />
  );
}

async function completeReads(): Promise<void> {
  for (const { key, load } of pending) values.set(key, await load());
}

const pipeline = (pipelineId: string): RailPipeline => ({ pipelineId, name: pipelineId });

describe("pipeline graph resources", () => {
  it("loads each legacy pipeline's own graph", async () => {
    const first = definition("first", "first-step");
    const second = definition("second", "second-step");
    const loadDefinition = vi.fn(async (id: string) => (id === "first" ? first : second));
    const api = { loadDefinition } as unknown as StudioApi;

    expect(renderGraph(api, pipeline("first"), [first])).toContain("Loading graph");
    await completeReads();
    expect(renderGraph(api, pipeline("first"), [first])).toContain("first-step");

    const switching = renderGraph(api, pipeline("second"), [second]);
    expect(switching).toContain("Loading graph");
    expect(switching).not.toContain("first-step");
    await completeReads();
    expect(renderGraph(api, pipeline("second"), [second])).toContain("second-step");

    expect(loadDefinition).toHaveBeenCalledWith("first", undefined);
    expect(loadDefinition).toHaveBeenCalledWith("second", undefined);
  });

  it("loads the latest recorded identity", async () => {
    const { step } = createSteps();
    const identity = definePipeline({ id: "modern", steps: [step("load", { run: () => 1 })] })
      .definition.identity;
    const latest = { ...definition("modern", "recorded-step"), identity, lastSeenAtMs: 3 };
    const older = definition("modern", "old-step");
    const loadDefinition = vi.fn(async () => latest);
    const api = { loadDefinition } as unknown as StudioApi;

    renderGraph(api, pipeline("modern"), [older, latest]);
    await completeReads();
    expect(renderGraph(api, pipeline("modern"), [older, latest])).toContain("recorded-step");
    expect(loadDefinition).toHaveBeenCalledWith("modern", identity.definitionId);
  });

  it("previews an unrecorded command and stops previewing once a definition is available", async () => {
    const { step } = createSteps();
    const plan = definePipeline({
      id: "modern",
      steps: [step("preview-step", { run: () => 1 })],
    }).plan();
    const previewPlan = vi.fn(async () => plan);
    const recorded = definition("modern", "recorded-step");
    const loadDefinition = vi.fn(async () => recorded);
    const api = { previewPlan, loadDefinition } as unknown as StudioApi;
    const commandPipeline: RailPipeline = {
      ...pipeline("modern"),
      command: { id: "modern", name: "Modern", canPlan: true, parameters: [] },
    };

    renderGraph(api, commandPipeline, []);
    await completeReads();
    expect(renderGraph(api, commandPipeline, [])).toContain("preview-step");
    expect(previewPlan).toHaveBeenCalledWith("modern", {});

    const switching = renderGraph(api, commandPipeline, [recorded]);
    expect(switching).not.toContain("preview-step");
    await completeReads();
    expect(renderGraph(api, commandPipeline, [recorded])).toContain("recorded-step");
    expect(previewPlan).toHaveBeenCalledTimes(1);
    expect(renderGraph(api, pipeline("unrecorded"), [])).toContain("No graph recorded");
  });
});
