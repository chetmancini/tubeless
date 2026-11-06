import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSteps, definePipeline } from "tubeless";
import type { StoredDefinitionSummary } from "../../run-store/run-history.js";
import type { StoredPipelineDefinition } from "../../run-store/run-store.js";
import { useDefinitionResource } from "./definition-resource.js";
import type { StudioApi } from "./transport.js";

const roots: Element[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await act(() => render(null, root));
});

async function mountDefinition(api: StudioApi, initial: StoredDefinitionSummary) {
  // SAFETY: the probe renders no DOM nodes, so Preact only needs root metadata.
  const root = {
    nodeType: 1,
    firstChild: null,
    namespaceURI: "http://www.w3.org/1999/xhtml",
  } as unknown as Element;
  roots.push(root);
  let current: ReturnType<typeof useDefinitionResource> | undefined;
  function Probe({ definition }: { definition: StoredDefinitionSummary }) {
    current = useDefinitionResource(api, definition);
    return null;
  }
  const mounted = {
    async update(definition: StoredDefinitionSummary) {
      await act(() => render(<Probe definition={definition} />, root));
      await act(async () => {});
    },
    get resource() {
      if (!current) throw new Error("Definition probe has not rendered.");
      return current;
    },
  };
  await mounted.update(initial);
  return mounted;
}

function definition(): StoredPipelineDefinition {
  return {
    pipelineId: "example",
    activeRuns: 0,
    firstSeenAtMs: 1,
    lastSeenAtMs: 2,
    runCount: 1,
    targetIds: [],
    steps: [],
  };
}

function pendingDefinition() {
  let resolve!: (value: StoredPipelineDefinition) => void;
  const promise = new Promise<StoredPipelineDefinition>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe("definition resource refresh", () => {
  it("refreshes an identified snapshot only when its run count advances", async () => {
    const { step } = createSteps();
    const identity = definePipeline({ id: "example", steps: [step("load", { run: () => 1 })] })
      .definition.identity;
    const initial = { ...definition(), identity };
    const next = pendingDefinition();
    const loadDefinition = vi.fn().mockResolvedValueOnce(initial).mockReturnValueOnce(next.promise);
    const mounted = await mountDefinition({ loadDefinition } as unknown as StudioApi, initial);
    expect(mounted.resource.value).toBe(initial);
    expect(mounted.resource.loading).toBe(false);

    const observed = { ...initial, lastSeenAtMs: 3 };
    await mounted.update(observed);
    expect(loadDefinition).toHaveBeenCalledTimes(1);

    const completed = { ...observed, runCount: 2, targetIds: ["load"] };
    await mounted.update(completed);
    expect(loadDefinition).toHaveBeenCalledTimes(2);
    expect(loadDefinition).toHaveBeenLastCalledWith("example", identity.definitionId);
    expect(mounted.resource.value).toBe(initial);
    expect(mounted.resource.loading).toBe(true);

    await act(async () => {
      next.resolve(completed);
      await next.promise;
    });
    expect(mounted.resource.value).toBe(completed);
    expect(mounted.resource.loading).toBe(false);
    await mounted.update({ ...completed });
    expect(loadDefinition).toHaveBeenCalledTimes(2);
  });

  it("refreshes a legacy graph when its observation timestamp advances", async () => {
    const initial = definition();
    const next = pendingDefinition();
    const loadDefinition = vi.fn().mockResolvedValueOnce(initial).mockReturnValueOnce(next.promise);
    const mounted = await mountDefinition({ loadDefinition } as unknown as StudioApi, initial);
    expect(mounted.resource.value).toBe(initial);

    const counted = { ...initial, runCount: 2 };
    await mounted.update(counted);
    expect(loadDefinition).toHaveBeenCalledTimes(1);

    const updated = { ...counted, lastSeenAtMs: 3, targetIds: ["replacement"] };
    await mounted.update(updated);
    expect(loadDefinition).toHaveBeenCalledTimes(2);
    expect(loadDefinition).toHaveBeenLastCalledWith("example", undefined);
    expect(mounted.resource.value).toBe(initial);
    expect(mounted.resource.loading).toBe(true);

    await act(async () => {
      next.resolve(updated);
      await next.promise;
    });
    expect(mounted.resource.value).toBe(updated);
    expect(mounted.resource.loading).toBe(false);
    await mounted.update({ ...updated });
    expect(loadDefinition).toHaveBeenCalledTimes(2);
  });
});
