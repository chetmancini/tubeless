import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, expect, it, vi } from "vitest";
import type { StudioTranscriptPage } from "../shared/schema.js";
import { transcriptRecord } from "../../tracing/agent-transcript.test-support.js";
import { useTranscript, TRANSCRIPT_REFRESH_MS } from "./transcript-resource.js";
import type { StudioApi } from "./transport.js";

const roots: Element[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await act(() => render(null, root));
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function pending() {
  let resolve!: (page: StudioTranscriptPage) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<StudioTranscriptPage>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function page(sequence = 1, runId = "run", nextSequence?: number): StudioTranscriptPage {
  return {
    transcript: {
      runId,
      status: "partial",
      records: [transcriptRecord(sequence, { kind: "assistant", text: "text" }, runId)],
      ...(nextSequence === undefined ? {} : { nextSequence }),
    },
    turnRuns: { [sequence]: `${runId}-turn-${sequence}` },
    live: false,
    sourceId: "source",
  };
}
async function mount(
  load: StudioApi["loadTranscript"],
  subscribeAccessDenied?: StudioApi["subscribeAccessDenied"]
) {
  let api = { loadTranscript: load, subscribeAccessDenied };
  // The probe emits no DOM, so Preact only needs root metadata.
  const root = {
    nodeType: 1,
    firstChild: null,
    namespaceURI: "http://www.w3.org/1999/xhtml",
  } as unknown as Element;
  roots.push(root);
  let current!: ReturnType<typeof useTranscript>;
  function Probe({ runId }: { runId: string }) {
    current = useTranscript(api, runId);
    return null;
  }
  const mounted = {
    get state() {
      return current;
    },
    async unmount() {
      await act(() => render(null, root));
    },
    async update(runId: string, nextLoad?: StudioApi["loadTranscript"]) {
      if (nextLoad) api = { loadTranscript: nextLoad, subscribeAccessDenied };
      await act(() => render(<Probe runId={runId} />, root));
      await act(async () => {});
    },
  };
  await mounted.update("run");
  return mounted;
}

it("coalesces page requests, retains prior records on error and retries the same cursor", async () => {
  const next = pending();
  const retry = pending();
  const load = vi
    .fn<StudioApi["loadTranscript"]>()
    .mockResolvedValueOnce(page(1, "run", 1))
    .mockReturnValueOnce(next.promise)
    .mockReturnValueOnce(retry.promise);
  const mounted = await mount(load);
  expect(mounted.state.page?.records).toHaveLength(1);
  expect(mounted.state.turnRuns).toEqual({ 1: "run-turn-1" });
  await act(() => {
    mounted.state.more();
    mounted.state.more();
  });
  expect(load).toHaveBeenCalledTimes(2);
  await act(async () => next.reject(new Error("Temporary failure")));
  expect(mounted.state.page?.records).toHaveLength(1);
  expect(mounted.state.error).toBe("Temporary failure");
  await act(() => mounted.state.more());
  expect(load).toHaveBeenLastCalledWith("run", 1, expect.any(AbortSignal));
  await act(async () => retry.resolve(page(2)));
  expect(mounted.state.page?.records.map((record) => record.sequence)).toEqual([1, 2]);
  expect(mounted.state.turnRuns).toEqual({ 1: "run-turn-1", 2: "run-turn-2" });
  expect(mounted.state.error).toBeUndefined();
});

it("retires an old run's request before displaying another run", async () => {
  const old = pending();
  const next = pending();
  const load = vi
    .fn<StudioApi["loadTranscript"]>()
    .mockReturnValueOnce(old.promise)
    .mockReturnValueOnce(next.promise);
  const mounted = await mount(load);
  const oldMore = mounted.state.more;
  await mounted.update("new-run");
  await act(() => oldMore());
  expect(load).toHaveBeenCalledTimes(2);
  await act(async () => next.resolve(page(1, "new-run")));
  await act(async () => old.resolve(page(1, "run")));
  expect(mounted.state.page?.runId).toBe("new-run");
  expect(mounted.state.turnRuns).toEqual({ 1: "new-run-turn-1" });
  expect(mounted.state.loading).toBe(false);
});

async function tick() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(TRANSCRIPT_REFRESH_MS);
  });
}
function live(sequence = 1): StudioTranscriptPage {
  return { ...page(sequence), live: true };
}

it.each(["complete", "limited"] as const)(
  "appends mutable pages and stops at %s",
  async (status) => {
    vi.useFakeTimers();
    const load = vi
      .fn<StudioApi["loadTranscript"]>()
      .mockResolvedValueOnce(live())
      .mockResolvedValueOnce(live(2))
      .mockResolvedValueOnce({ ...live(3), transcript: { ...page(3).transcript, status } });
    const mounted = await mount(load);
    await tick();
    expect(load).toHaveBeenLastCalledWith("run", 1, expect.any(AbortSignal));
    expect(mounted.state.page?.records.map((record) => record.sequence)).toEqual([1, 2]);
    await tick();
    expect(mounted.state.page?.status).toBe(status);
    expect(mounted.state.page?.records.map((record) => record.sequence)).toEqual([1, 2, 3]);
    await tick();
    expect(load).toHaveBeenCalledTimes(3);
  }
);

it("polls unavailable content, updates status on empty pages and keeps snapshots fixed", async () => {
  vi.useFakeTimers();
  const load = vi
    .fn<StudioApi["loadTranscript"]>()
    .mockResolvedValueOnce({
      ...live(),
      transcript: { runId: "run", records: [], status: "unavailable" },
    })
    .mockResolvedValueOnce(live())
    .mockResolvedValueOnce({
      ...live(),
      transcript: { runId: "run", records: [], status: "complete" },
    });
  const mounted = await mount(load);
  await tick();
  expect(load).toHaveBeenLastCalledWith("run", 0, expect.any(AbortSignal));
  await tick();
  expect(mounted.state.page).toMatchObject({
    status: "complete",
    records: [expect.objectContaining({ sequence: 1 })],
  });
  const snapshot = vi.fn<StudioApi["loadTranscript"]>().mockResolvedValue(page());
  await mounted.update("run", snapshot);
  await tick();
  expect(snapshot).toHaveBeenCalledOnce();
});

it("keeps terminal recordings pageable without polling them", async () => {
  vi.useFakeTimers();
  const first = live();
  const last = live(2);
  const load = vi
    .fn<StudioApi["loadTranscript"]>()
    .mockResolvedValueOnce({
      ...first,
      transcript: { ...first.transcript, status: "complete", nextSequence: 1 },
    })
    .mockResolvedValueOnce({ ...last, transcript: { ...last.transcript, status: "complete" } });
  const mounted = await mount(load);
  await tick();
  expect(load).toHaveBeenCalledOnce();
  expect(mounted.state.page?.nextSequence).toBe(1);
  await act(async () => mounted.state.more());
  expect(load).toHaveBeenLastCalledWith("run", 1, expect.any(AbortSignal));
  expect(mounted.state.page?.records.map((record) => record.sequence)).toEqual([1, 2]);
  expect(mounted.state.page?.nextSequence).toBeUndefined();
  await tick();
  expect(load).toHaveBeenCalledTimes(2);
});

it("aborts pending requests and timers on source changes and unmount", async () => {
  vi.useFakeTimers();
  const old = pending();
  const load = vi.fn<StudioApi["loadTranscript"]>().mockReturnValue(old.promise);
  const mounted = await mount(load);
  const signal = load.mock.calls[0]![2]!;
  const next = vi.fn<StudioApi["loadTranscript"]>().mockResolvedValue(live(2));
  await mounted.update("run", next);
  expect(signal.aborted).toBe(true);
  await act(async () => old.resolve(live()));
  expect(mounted.state.page?.records.map((record) => record.sequence)).toEqual([2]);
  await mounted.unmount();
  await tick();
  expect(next).toHaveBeenCalledOnce();
});

it("pauses hidden tabs and resumes from the last successful cursor", async () => {
  vi.useFakeTimers();
  const document = Object.assign(new EventTarget(), { hidden: false });
  vi.stubGlobal("document", document);
  const waiting = pending();
  const load = vi
    .fn<StudioApi["loadTranscript"]>()
    .mockResolvedValueOnce(live())
    .mockReturnValueOnce(waiting.promise)
    .mockResolvedValue(live(2));
  const mounted = await mount(load);
  await tick();
  const signal = load.mock.calls[1]![2]!;
  await act(() => {
    document.hidden = true;
    document.dispatchEvent(new Event("visibilitychange"));
  });
  expect(signal.aborted).toBe(true);
  await tick();
  expect(load).toHaveBeenCalledTimes(2);
  await act(async () => {
    document.hidden = false;
    document.dispatchEvent(new Event("visibilitychange"));
  });
  expect(load).toHaveBeenLastCalledWith("run", 1, expect.any(AbortSignal));
  expect(mounted.state.page?.records.map((record) => record.sequence)).toEqual([1, 2]);
  await act(async () => waiting.resolve(live(9)));
  expect(mounted.state.page?.records.map((record) => record.sequence)).toEqual([1, 2]);
});

it("retires reads, clears private content and stops polling on authorization denial", async () => {
  vi.useFakeTimers();
  let deny!: (status: 401 | 403) => void;
  const unsubscribe = vi.fn();
  const waiting = pending();
  const load = vi
    .fn<StudioApi["loadTranscript"]>()
    .mockResolvedValueOnce(live())
    .mockReturnValueOnce(waiting.promise);
  const mounted = await mount(load, (listener) => {
    deny = listener;
    return unsubscribe;
  });
  await tick();
  const signal = load.mock.calls[1]![2]!;
  await act(() => deny(403));
  expect(signal.aborted).toBe(true);
  expect(mounted.state.page).toBeUndefined();
  expect(mounted.state.error).toBe("Access denied.");
  await act(async () => waiting.resolve(live(2)));
  await tick();
  await act(() => mounted.state.more());
  expect(load).toHaveBeenCalledTimes(2);
  await mounted.unmount();
  expect(unsubscribe).toHaveBeenCalledOnce();
});

it("restarts at zero when the server replaces the transcript source", async () => {
  vi.useFakeTimers();
  const load = vi
    .fn<StudioApi["loadTranscript"]>()
    .mockResolvedValueOnce(live())
    .mockResolvedValueOnce({ ...live(20), sourceId: "replacement" })
    .mockResolvedValueOnce({ ...page(1, "run"), sourceId: "replacement" });
  const mounted = await mount(load);
  await tick();
  expect(load).toHaveBeenNthCalledWith(2, "run", 1, expect.any(AbortSignal));
  expect(load).toHaveBeenLastCalledWith("run", 0, expect.any(AbortSignal));
  expect(mounted.state.page?.records.map((record) => record.sequence)).toEqual([1]);
});

it("pauses failed refreshes and retries the cursor without duplicating loaded pages", async () => {
  vi.useFakeTimers();
  const load = vi
    .fn<StudioApi["loadTranscript"]>()
    .mockResolvedValueOnce(live())
    .mockRejectedValueOnce(new Error("Temporary failure"))
    .mockResolvedValueOnce(live(2));
  const mounted = await mount(load);
  await tick();
  expect(mounted.state.error).toBe("Temporary failure");
  expect(mounted.state.page?.records.map((record) => record.sequence)).toEqual([1]);
  await tick();
  expect(load).toHaveBeenCalledTimes(2);
  await act(async () => mounted.state.more());
  expect(load).toHaveBeenLastCalledWith("run", 1, expect.any(AbortSignal));
  expect(mounted.state.page?.records.map((record) => record.sequence)).toEqual([1, 2]);
});
