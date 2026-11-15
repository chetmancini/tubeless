import { DatabaseSync } from "node:sqlite";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { transcriptRecord } from "../tracing/agent-transcript.test-support.js";
import { openSqlitePipelineRunStore } from "./run-store-sqlite.js";

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "tubeless-sqlite-transcript-"));
  directories.push(directory);
  const filename = join(directory, "runs.sqlite");
  const store = await openSqlitePipelineRunStore(filename);
  await store.export({
    name: "pipeline.started",
    payload: { dryRun: false, planOk: true, stepCount: 0, targetIds: [] },
    pipelineId: "agent",
    runId: "agent:one",
    timestampMs: 1,
    version: 3,
  });
  return { directory, filename, store };
}
const end = (sequence: number) => transcriptRecord(sequence, { kind: "end", status: "completed" });

describe("SQLite transcripts", () => {
  it("persists idempotent, ordered pages without modifying finished artifacts on read", async () => {
    const { directory, filename, store } = await fixture();
    try {
      const records = [end(3), transcriptRecord(1), transcriptRecord(2)];
      expect(store.importTranscript([...records, records[0]!])).toBe(3);
      expect(store.importTranscript(records)).toBe(0);
    } finally {
      await store.close();
    }
    const before = await readFile(filename);
    const names = await readdir(directory);
    const reader = await openSqlitePipelineRunStore(filename, {
      initialize: false,
      readOnly: true,
    });
    try {
      const first = await reader.transcripts.list({ runId: "agent:one", limit: 2 });
      expect(first).toMatchObject({ status: "complete", nextSequence: 2 });
      expect(first.records.map((record) => record.sequence)).toEqual([1, 2]);
      expect(await reader.transcripts.list({ runId: "agent:one", afterSequence: 2 })).toEqual({
        runId: "agent:one",
        records: [end(3)],
        status: "complete",
      });
      expect(await reader.transcripts.list({ runId: "agent:one", afterSequence: 50 })).toEqual({
        runId: "agent:one",
        records: [],
        status: "complete",
      });
      expect(await reader.transcripts.list({ runId: "missing" })).toMatchObject({
        status: "unavailable",
        records: [],
      });
      expect(() => reader.importTranscript(recordsForImport())).toThrow("read-only");
      for (const query of [
        { afterSequence: -1 },
        { limit: 0 },
        { limit: 51 },
        { afterSequence: Infinity },
      ])
        await expect(reader.transcripts.list({ runId: "agent:one", ...query })).rejects.toThrow(
          "cursor"
        );
    } finally {
      await reader.close();
    }
    expect(await readFile(filename)).toEqual(before);
    expect(await readdir(directory)).toEqual(names);
    await expect(reader.transcripts.list({ runId: "agent:one" })).rejects.toThrow("closed");
  });

  it("keeps gaps partial and distinguishes terminal byte limits", async () => {
    const { store } = await fixture();
    try {
      expect(await store.transcripts.list({ runId: "agent:one" })).toMatchObject({
        status: "unavailable",
      });
      store.importTranscript([end(3)]);
      expect(await store.transcripts.list({ runId: "agent:one" })).toMatchObject({
        status: "partial",
      });
      store.importTranscript([transcriptRecord(1), transcriptRecord(2)]);
      expect(await store.transcripts.list({ runId: "agent:one" })).toMatchObject({
        status: "complete",
      });
      await store.clearHistory();
      await store.export({
        name: "pipeline.started",
        payload: { dryRun: false, planOk: true, stepCount: 0, targetIds: [] },
        pipelineId: "agent",
        runId: "agent:one",
        timestampMs: 1,
        version: 3,
      });
      const { event: _, ...envelope } = transcriptRecord(2);
      store.importTranscript([transcriptRecord(1), { ...envelope, limit: "maxBytes" }]);
      expect(await store.transcripts.list({ runId: "agent:one", limit: 1 })).toMatchObject({
        status: "limited",
        nextSequence: 1,
      });
    } finally {
      await store.close();
    }
  });

  it("rolls back the whole import on conflicts, identity changes and absent history", async () => {
    const { store } = await fixture();
    try {
      store.importTranscript([transcriptRecord(1)]);
      for (const conflicting of [
        transcriptRecord(1, { kind: "assistant", text: "different" }),
        { ...end(3), agentId: "other" },
        { ...end(3), parentRunId: "other" },
        { ...end(3), dryRun: true },
        transcriptRecord(1, undefined, "unknown"),
      ]) {
        expect(() => store.importTranscript([transcriptRecord(2), conflicting])).toThrow();
        expect((await store.transcripts.list({ runId: "agent:one" })).records).toEqual([
          transcriptRecord(1),
        ]);
      }
      expect(() =>
        store.importTranscript([
          transcriptRecord(2, { kind: "assistant", text: "x".repeat(70_000) }),
        ])
      ).toThrow();
      expect(
        (await store.listEvents()).every((event) => !JSON.stringify(event).includes("Visible text"))
      ).toBe(true);
    } finally {
      await store.close();
    }
  });

  it("clears events and content in one transaction and restores both on failure", async () => {
    const { store } = await fixture();
    try {
      store.importTranscript(recordsForImport());
      const original = DatabaseSync.prototype.exec;
      const injected = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (
        this: DatabaseSync,
        sql
      ) {
        if (sql.includes("DELETE FROM agent_transcript_records"))
          throw new Error("content deletion failed");
        return original.call(this, sql);
      });
      expect(() => store.clearHistory()).toThrow("content deletion failed");
      injected.mockRestore();
      expect(await store.listEvents()).toHaveLength(1);
      expect(await store.transcripts.list({ runId: "agent:one" })).toMatchObject({
        status: "complete",
      });
      await store.clearHistory();
      expect(await store.listEvents()).toEqual([]);
      expect(await store.transcripts.list({ runId: "agent:one" })).toMatchObject({
        records: [],
        status: "unavailable",
      });
    } finally {
      await store.close();
    }
  });

  it("discovers imports from another connection and refuses corrupt storage keys", async () => {
    const { filename, store } = await fixture();
    const other = await openSqlitePipelineRunStore(filename);
    try {
      expect(await other.transcripts.list({ runId: "agent:one" })).toMatchObject({
        status: "unavailable",
      });
      store.importTranscript(recordsForImport());
      expect(await other.transcripts.list({ runId: "agent:one" })).toMatchObject({
        status: "complete",
      });
      const database = new DatabaseSync(filename);
      try {
        expect(() => database.exec("DELETE FROM agent_transcript_records")).toThrow("append-only");
        expect(() =>
          database.exec("UPDATE agent_transcript_records SET sequence = sequence + 1")
        ).toThrow("append-only");
        database.exec("DROP TRIGGER agent_transcript_records_no_update");
        database
          .prepare("UPDATE agent_transcript_records SET record_json = ? WHERE sequence = 1")
          .run(JSON.stringify(transcriptRecord(1, undefined, "other")));
      } finally {
        database.close();
      }
      await expect(store.transcripts.list({ runId: "agent:one" })).rejects.toThrow("storage key");
    } finally {
      await other.close();
      await store.close();
    }
  });
});

function recordsForImport() {
  return [transcriptRecord(1), end(2)];
}
