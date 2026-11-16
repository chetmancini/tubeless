import { afterEach, expect, it, vi } from "vitest";
import { transcriptRecord } from "../tracing/agent-transcript.test-support.js";
import { createFakeDurableStorage } from "./cloudflare-storage.test-support.js";
import { openDurableRunStore } from "./cloudflare-run-store.js";
import { createCloudflareAgentTranscriptWriter } from "./cloudflare-transcript.js";
import { StudioObjectCore } from "./cloudflare-studio.js";

afterEach(() => vi.useRealTimers());
function setup() {
  const storage = createFakeDurableStorage();
  const store = openDurableRunStore(storage);
  const start = () =>
    storage.transactionSync(() =>
      store.append([
        {
          version: 3,
          name: "pipeline.started",
          pipelineId: "agent",
          runId: "agent:one",
          timestampMs: 1,
          payload: { dryRun: false, planOk: true, stepCount: 0, targetIds: [] },
        },
      ])
    );
  return { storage, store, start };
}

it("leaves old history without content tables and refuses orphaned transcripts", async () => {
  const { storage, store } = setup();
  expect(store.appendTranscript(transcriptRecord())).toBe(false);
  expect(await store.transcripts.list({ runId: "agent:one" })).toEqual({
    runId: "agent:one",
    records: [],
    status: "unavailable",
  });
  expect(
    storage.sql
      .exec("SELECT name FROM sqlite_master WHERE name LIKE 'agent_transcript_%'")
      .toArray()
  ).toEqual([]);
});

it("persists idempotent pages, discovers earlier imports and survives reopening", async () => {
  const { storage, store, start } = setup();
  start();
  const end = transcriptRecord(3, { kind: "end", status: "completed" });
  expect(store.appendTranscript(end)).toBe(true);
  expect((await store.transcripts.list({ runId: "agent:one" })).status).toBe("partial");
  for (const record of [transcriptRecord(1), transcriptRecord(2), end])
    expect(store.appendTranscript(record)).toBe(true);
  const reopened = openDurableRunStore(storage);
  expect(await reopened.transcripts.list({ runId: "agent:one", limit: 2 })).toMatchObject({
    status: "complete",
    records: [transcriptRecord(1), transcriptRecord(2)],
    nextSequence: 2,
  });
  expect(await reopened.transcripts.list({ runId: "agent:one", afterSequence: 2 })).toMatchObject({
    records: [end],
    status: "complete",
  });
  await expect(reopened.transcripts.list({ runId: "agent:one", limit: 51 })).rejects.toThrow(
    "cursor"
  );
  expect(() => storage.sql.exec("DELETE FROM agent_transcript_records")).toThrow("append-only");
});

it("checks structural identity, conflicts and record bounds before changing content", async () => {
  const { store, start } = setup();
  start();
  store.appendTranscript(transcriptRecord());
  for (const record of [
    { ...transcriptRecord(2), agentId: "other" },
    { ...transcriptRecord(2), parentRunId: "other" },
    { ...transcriptRecord(2), dryRun: true },
    transcriptRecord(1, { kind: "assistant", text: "conflict" }),
    transcriptRecord(2, { kind: "assistant", text: "x".repeat(70_000) }),
  ])
    expect(() => store.appendTranscript(record)).toThrow();
  expect((await store.transcripts.list({ runId: "agent:one" })).records).toEqual([
    transcriptRecord(),
  ]);
});

it("clears content and events atomically and restores both when deletion fails", async () => {
  const { storage, store, start } = setup();
  start();
  store.appendTranscript(transcriptRecord());
  const exec = storage.sql.exec.bind(storage.sql);
  const failure = vi.spyOn(storage.sql, "exec").mockImplementation((query, ...bindings) => {
    if (query === "DELETE FROM pipeline_run_events") throw new Error("delete failed");
    return exec(query, ...bindings);
  });
  expect(() => storage.transactionSync(() => store.clearHistory())).toThrow("delete failed");
  failure.mockRestore();
  expect(await store.listEvents()).toHaveLength(1);
  expect((await store.transcripts.list({ runId: "agent:one" })).records).toHaveLength(1);
  storage.transactionSync(() => store.clearHistory());
  expect(await store.listEvents()).toEqual([]);
  expect((await store.transcripts.list({ runId: "agent:one" })).status).toBe("unavailable");
  expect(store.appendTranscript(transcriptRecord())).toBe(false);
  start();
  expect(() => storage.sql.exec("DELETE FROM pipeline_run_events")).toThrow("append-only");
});

it("retries delayed history and lost acknowledgements without duplicating records", async () => {
  vi.useFakeTimers();
  const { store, start } = setup();
  let lost = false;
  const appendTranscript = vi.fn(async (record) => {
    const accepted = store.appendTranscript(record);
    if (accepted && !lost) {
      lost = true;
      throw new Error("acknowledgement lost");
    }
    return { accepted };
  });
  const writer = createCloudflareAgentTranscriptWriter(() => ({ appendTranscript }));
  const writing = writer.write(transcriptRecord());
  await vi.advanceTimersByTimeAsync(0);
  expect(appendTranscript).toHaveBeenCalledOnce();
  start();
  await vi.advanceTimersByTimeAsync(1_000);
  await writing;
  expect(appendTranscript).toHaveBeenCalledTimes(3);
  expect((await store.transcripts.list({ runId: "agent:one" })).records).toHaveLength(1);
  expect(vi.getTimerCount()).toBe(0);
});

it.each(["absent", "error", "hung"])("bounds %s deliveries and cleans its timers", async (mode) => {
  vi.useFakeTimers();
  const appendTranscript = vi.fn(async () => {
    if (mode === "hung") return new Promise<{ accepted: boolean }>(() => {});
    if (mode === "error") throw new Error("transport failed");
    return { accepted: false };
  });
  const writer = createCloudflareAgentTranscriptWriter(() => ({ appendTranscript }));
  const rejected = expect(writer.write(transcriptRecord())).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(5_001);
  await rejected;
  expect(appendTranscript).toHaveBeenCalledTimes(mode === "hung" ? 1 : 5);
  expect(vi.getTimerCount()).toBe(0);
});

it("exposes stored content and coordinated clearing through the Studio host", async () => {
  const { storage, store, start } = setup();
  start();
  store.appendTranscript(transcriptRecord());
  const core = new StudioObjectCore({
    projectId: "transcript-test",
    storage,
    commands: new Map(),
    clientScript: "",
    maxRunDurationMs: 1_000,
    runStub: () => {
      throw new Error("unused");
    },
  });
  const get = (path: string) => core.fetch(new Request("http://localhost" + path));
  expect(await (await get("/api/runs/agent%3Aone/transcript")).json()).toMatchObject({
    live: true,
    transcript: { records: [transcriptRecord()] },
  });
  storage.sql.exec(
    "INSERT INTO tubeless_launches (launch_id, command_id, state, created_at_ms) VALUES ('pending', 'agent', 'starting', 1)"
  );
  const clear = () =>
    core.fetch(
      new Request("http://localhost/api/history", {
        method: "DELETE",
        headers: { origin: "http://localhost", "x-tubeless-studio-clear-history": "1" },
      })
    );
  expect((await clear()).status).toBe(409);
  expect(await store.listEvents()).toHaveLength(1);
  storage.sql.exec("UPDATE tubeless_launches SET state = 'finished'");
  expect((await clear()).status).toBe(200);
  expect((await get("/api/runs/agent%3Aone/transcript")).status).toBe(404);
  expect(await core.appendTranscript(transcriptRecord())).toEqual({ accepted: false });
});
