import { renderToString } from "preact-render-to-string";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSteps, definePipeline } from "../../../core/pipeline.js";
import type { StoredDefinitionSummary } from "../../../run-store/run-history.js";
import type { StudioApi } from "../transport.js";
import { PipelinePage } from "./pipeline.js";
import type { RailPipeline } from "./rail.js";

const resource = vi.hoisted(() => vi.fn());
vi.mock("../resource.js", () => ({ useStudioResource: resource }));

beforeEach(() => {
  resource.mockReset();
  resource.mockReturnValue({ value: null, loading: true, reload: () => {} });
});

const api = {} as StudioApi;
const legacy = (pipelineId: string): StoredDefinitionSummary => ({
  pipelineId,
  activeRuns: 0,
  firstSeenAtMs: 1,
  lastSeenAtMs: 2,
  runCount: 1,
});

function graphKey(pipeline: RailPipeline, definitions: readonly StoredDefinitionSummary[]) {
  renderToString(
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
  return resource.mock.lastCall![1] as string;
}

const pipeline = (pipelineId: string): RailPipeline => ({ pipelineId, name: pipelineId });

describe("pipeline graph resource identity", () => {
  it("separates legacy pipelines while retaining identity across same-pipeline refreshes", () => {
    const first = graphKey(pipeline("first"), [legacy("first")]);
    const second = graphKey(pipeline("second"), [legacy("second")]);
    const refreshed = graphKey(pipeline("first"), [
      { ...legacy("first"), lastSeenAtMs: 3, runCount: 2 },
    ]);
    expect(first).not.toBe(second);
    expect(refreshed).toBe(first);
  });

  it("separates identified definitions and keeps plan previews available", () => {
    const { step } = createSteps();
    const load = step("load", { run: () => 1 });
    const identity = definePipeline({ id: "modern", steps: [load] }).definition.identity;
    const recorded = graphKey(pipeline("modern"), [{ ...legacy("modern"), identity }]);
    const legacyKey = graphKey(pipeline("modern"), [legacy("modern")]);
    const planning = graphKey(
      {
        ...pipeline("modern"),
        command: {
          id: "modern",
          name: "Modern",
          canPlan: true,
          parameters: [],
        },
      },
      []
    );
    expect(recorded).not.toBe(legacyKey);
    expect(recorded).not.toBe(planning);
    expect(planning).not.toBe("");
    expect(graphKey(pipeline("unrecorded"), [])).toBe("");
  });
});
