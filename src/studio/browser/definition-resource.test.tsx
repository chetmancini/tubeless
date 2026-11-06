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
  let currentApi = api;
  // SAFETY: the probe renders no DOM nodes, so Preact only needs root metadata.
  const root = {
    nodeType: 1,
    firstChild: null,
    namespaceURI: "http://www.w3.org/1999/xhtml",
  } as unknown as Element;
  roots.push(root);
  let current: ReturnType<typeof useDefinitionResource> | undefined;
  function Probe({ api, definition }: { api: StudioApi; definition: StoredDefinitionSummary }) {
    current = useDefinitionResource(api, definition);
    return null;
  }
  const mounted = {
    async update(definition: StoredDefinitionSummary, nextApi = currentApi) {
      currentApi = nextApi;
      await act(() => render(<Probe api={currentApi} definition={definition} />, root));
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
  let reject!: (error: Error) => void;
  const promise = new Promise<StoredPipelineDefinition>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
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

  it("retires a pending refresh when the selected definition identity changes", async () => {
    const { step } = createSteps();
    const identify = (id: string) =>
      definePipeline({ id: "example", steps: [step(id, { run: () => 1 })] }).definition.identity;
    const initial = { ...definition(), identity: identify("original") };
    const replacement = { ...definition(), identity: identify("replacement") };
    const stale = pendingDefinition();
    const next = pendingDefinition();
    const loadDefinition = vi
      .fn()
      .mockResolvedValueOnce(initial)
      .mockReturnValueOnce(stale.promise)
      .mockReturnValueOnce(next.promise);
    const mounted = await mountDefinition({ loadDefinition } as unknown as StudioApi, initial);
    expect(mounted.resource.value).toBe(initial);

    await mounted.update({ ...initial, runCount: 2 });
    expect(mounted.resource.value).toBe(initial);
    await mounted.update(replacement);
    expect(loadDefinition).toHaveBeenLastCalledWith("example", replacement.identity.definitionId);
    expect(mounted.resource.value).toBeNull();
    expect(mounted.resource.loading).toBe(true);

    await act(async () => {
      stale.resolve({ ...initial, targetIds: ["stale"] });
      await stale.promise;
    });
    expect(mounted.resource.value).toBeNull();
    expect(mounted.resource.loading).toBe(true);

    await act(async () => {
      next.resolve(replacement);
      await next.promise;
    });
    expect(mounted.resource.value).toBe(replacement);
    expect(mounted.resource.loading).toBe(false);
  });

  it("clears the previous API's snapshot and ignores its late failures", async () => {
    const initial = definition();
    const stale = pendingDefinition();
    const loadDefinition = vi
      .fn()
      .mockResolvedValueOnce(initial)
      .mockReturnValueOnce(stale.promise);
    const mounted = await mountDefinition({ loadDefinition } as unknown as StudioApi, initial);
    await mounted.update({ ...initial, lastSeenAtMs: 3 });
    expect(mounted.resource.value).toBe(initial);

    const next = pendingDefinition();
    const replacementApi = { loadDefinition: vi.fn(() => next.promise) } as unknown as StudioApi;
    await mounted.update(initial, replacementApi);
    expect(replacementApi.loadDefinition).toHaveBeenCalledWith("example", undefined);
    expect(mounted.resource.value).toBeNull();
    expect(mounted.resource.loading).toBe(true);

    const replacement = { ...initial, targetIds: ["new-api"] };
    await act(async () => {
      next.resolve(replacement);
      await next.promise;
    });
    await act(async () => {
      stale.reject(new Error("old API unavailable"));
      await stale.promise.catch(() => {});
    });
    expect(mounted.resource.value).toBe(replacement);
    expect(mounted.resource.loading).toBe(false);
    expect(mounted.resource.error).toBeUndefined();
  });
});
