import { render } from "preact";
import { act } from "preact/test-utils";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { openSqlitePipelineRunStore } from "../../run-store/run-store-sqlite.js";
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

async function storedTranscript() {
  const directory = await mkdtemp(join(tmpdir(), "tubeless-transcript-gaps-"));
  const store = await openSqlitePipelineRunStore(join(directory, "runs.sqlite"));
  await store.export({
    version: 3,
    name: "pipeline.started",
    pipelineId: "agent",
    runId: "run",
    timestampMs: 1,
    payload: { dryRun: false, planOk: true, stepCount: 0, targetIds: [] },
  });
  const load = vi
    .fn<StudioApi["loadTranscript"]>()
    .mockImplementation(async (runId, afterSequence) => ({
      transcript: await store.transcripts.list({ runId, afterSequence, limit: 2 }),
      sourceId: "source",
      live: true,
      turnRuns: {},
    }));
  return {
    store,
    load,
    async close() {
      await store.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

it.each([
  { sequence: 3, start: 3, terminal: "complete" },
  { sequence: 3, start: 3, terminal: "limited" },
  { sequence: 8, start: 8, terminal: "complete" },
  { sequence: 8, start: 8, terminal: "limited" },
  { sequence: 8, start: 2, terminal: "complete" },
] as const)(
  "backfills earlier SQLite gaps across bounded pages ($sequence, $terminal, start=$start)",
  async ({ sequence, start, terminal }) => {
    vi.useFakeTimers();
    const fixture = await storedTranscript();
    let mounted: Awaited<ReturnType<typeof mount>> | undefined;
    try {
      const last = transcriptRecord(sequence, { kind: "end", status: "completed" }, "run");
      const { event: _, ...envelope } = last;
      const initial = [
        ...Array.from({ length: sequence - start }, (_, index) =>
          transcriptRecord(start + index, undefined, "run")
        ),
        terminal === "complete" ? last : { ...envelope, limit: "maxBytes" as const },
      ];
      fixture.store.importTranscript(initial);
      mounted = await mount(fixture.load);
      expect(mounted.state.page?.status).toBe("partial");
      expect(mounted.state.page?.records).toEqual(initial.slice(0, 2));
      const earlier = Array.from({ length: start - 1 }, (_, index) =>
        transcriptRecord(index + 1, undefined, "run")
      );
      fixture.store.importTranscript(earlier);
      for (let index = 0; index <= Math.ceil(sequence / 2); index++) await tick();
      expect(mounted.state.page?.records.map((record) => record.sequence)).toEqual(
        Array.from({ length: sequence }, (_, index) => index + 1)
      );
      expect(mounted.state.page?.status).toBe(terminal);
      const calls = fixture.load.mock.calls.length;
      await tick();
      expect(fixture.load).toHaveBeenCalledTimes(calls);
    } finally {
      await mounted?.unmount();
      await fixture.close();
    }
  }
);

it("keeps paging and discovering appends while an earlier SQLite gap remains", async () => {
  vi.useFakeTimers();
  const fixture = await storedTranscript();
  let mounted: Awaited<ReturnType<typeof mount>> | undefined;
  try {
    fixture.store.importTranscript(
      [2, 3, 4].map((sequence) => transcriptRecord(sequence, undefined, "run"))
    );
    mounted = await mount(fixture.load);
    await act(async () => {
      mounted!.state.more();
      await fixture.load.mock.results.at(-1)!.value;
    });
    expect(mounted.state.page?.records.map((record) => record.sequence)).toEqual([2, 3, 4]);
    fixture.store.importTranscript([transcriptRecord(5, undefined, "run")]);
    await tick();
    await tick();
    expect(mounted.state.page?.records.map((record) => record.sequence)).toEqual([2, 3, 4, 5]);
    expect(mounted.state.page?.status).toBe("partial");
    expect(fixture.load.mock.calls.map(([, afterSequence]) => afterSequence)).toEqual([0, 3, 0, 3]);
  } finally {
    await mounted?.unmount();
    await fixture.close();
  }
});

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
