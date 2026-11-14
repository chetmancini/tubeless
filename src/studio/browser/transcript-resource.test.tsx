import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, expect, it, vi } from "vitest";
import type { AgentTranscriptPage } from "../../tracing/agent-transcript.js";
import { transcriptRecord } from "../../tracing/agent-transcript.test-support.js";
import { useTranscript } from "./transcript-resource.js";
import type { StudioApi } from "./transport.js";

const roots: Element[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await act(() => render(null, root));
});
function pending() {
  let resolve!: (page: AgentTranscriptPage) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<AgentTranscriptPage>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function page(sequence = 1, runId = "run", nextSequence?: number): AgentTranscriptPage {
  return {
    runId,
    status: "partial",
    records: [transcriptRecord(sequence, { kind: "assistant", text: "text" }, runId)],
    ...(nextSequence === undefined ? {} : { nextSequence }),
  };
}
async function mount(load: NonNullable<StudioApi["loadTranscript"]>) {
  // The probe emits no DOM, so Preact only needs root metadata.
  const root = {
    nodeType: 1,
    firstChild: null,
    namespaceURI: "http://www.w3.org/1999/xhtml",
  } as unknown as Element;
  roots.push(root);
  let current!: ReturnType<typeof useTranscript>;
  function Probe({ runId }: { runId: string }) {
    current = useTranscript(load, runId);
    return null;
  }
  const mounted = {
    get state() {
      return current;
    },
    async update(runId: string) {
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
    .fn<NonNullable<StudioApi["loadTranscript"]>>()
    .mockResolvedValueOnce(page(1, "run", 1))
    .mockReturnValueOnce(next.promise)
    .mockReturnValueOnce(retry.promise);
  const mounted = await mount(load);
  expect(mounted.state.page?.records).toHaveLength(1);
  await act(() => {
    mounted.state.more();
    mounted.state.more();
  });
  expect(load).toHaveBeenCalledTimes(2);
  await act(async () => next.reject(new Error("Temporary failure")));
  expect(mounted.state.page?.records).toHaveLength(1);
  expect(mounted.state.error).toBe("Temporary failure");
  await act(() => mounted.state.more());
  expect(load).toHaveBeenLastCalledWith("run", 1);
  await act(async () => retry.resolve(page(2)));
  expect(mounted.state.page?.records.map((record) => record.sequence)).toEqual([1, 2]);
  expect(mounted.state.error).toBeUndefined();
});

it("retires an old run's request before displaying another run", async () => {
  const old = pending();
  const next = pending();
  const load = vi
    .fn<NonNullable<StudioApi["loadTranscript"]>>()
    .mockReturnValueOnce(old.promise)
    .mockReturnValueOnce(next.promise);
  const mounted = await mount(load);
  await mounted.update("new-run");
  await act(async () => next.resolve(page(1, "new-run")));
  await act(async () => old.resolve(page(1, "run")));
  expect(mounted.state.page?.runId).toBe("new-run");
  expect(mounted.state.loading).toBe(false);
});
