import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSteps, definePipeline } from "../core/pipeline.js";
import { defaultPipelineContext } from "../core/pipeline-execute.js";
import type { PipelineTraceEvent } from "../tracing/tracing.js";
import { createFakeDurableStorage } from "../cloudflare/cloudflare-storage.test-support.js";
import { openDurableRunStore } from "../cloudflare/cloudflare-run-store.js";
import { SqliteHostedLaunchStore } from "./launch-store-sqlite.js";
import { createSqliteLaunchStoreFixture } from "./launch-store-sqlite.test-support.js";
import type { HostedAttemptOwner } from "./attempt-store.js";

const owner: HostedAttemptOwner = { launchId: "launch", attemptId: "attempt", workerId: "worker" };
const definition = {
  launchId: owner.launchId,
  attemptId: owner.attemptId,
  commandId: "command",
  pipelineId: "pipeline",
  deploymentId: "release-1",
  createdAtMs: 0,
};
const started = (runId = "root", parentRunId?: string): PipelineTraceEvent => ({
  version: 3,
  name: "pipeline.started",
  pipelineId: "pipeline",
  runId,
  timestampMs: 1,
  ...(parentRunId === undefined ? {} : { parentRunId }),
  payload: { dryRun: false, planOk: true, stepCount: 0, targetIds: [] },
});
const log = (runId = "root", parentRunId?: string): PipelineTraceEvent => ({
  version: 3,
  name: "pipeline.log",
  pipelineId: "pipeline",
  runId,
  timestampMs: 2,
  ...(parentRunId === undefined ? {} : { parentRunId }),
  payload: { level: "log", message: "hello" },
});
const completed = (): PipelineTraceEvent => ({
  version: 3,
  name: "pipeline.completed",
  pipelineId: "pipeline",
  runId: "root",
  timestampMs: 3,
  payload: { dryRun: false, errorCount: 0, finalized: true, status: "completed", stepCount: 0 },
});
const body = (
  sequence: number,
  events: readonly PipelineTraceEvent[],
  attemptId = owner.attemptId
) => new TextEncoder().encode(JSON.stringify({ attemptId, sequence, events }));

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.reverse()) await close();
  cleanup.length = 0;
});
function setup(filename?: string) {
  const fixture = createSqliteLaunchStoreFixture(filename);
  cleanup.push(() => fixture.store.close());
  return fixture;
}
async function claimed(filename?: string) {
  const fixture = setup(filename);
  await fixture.store.createAttempt(definition);
  expect(await fixture.store.claimAttempt(owner, definition.deploymentId, 1)).toBe(true);
  return fixture;
}
const conflict = (code: string) => ({ name: "HostedAttemptConflict", code });

describe("persisted hosted attempts", () => {
  it("grants exactly one claim, even for repeat requests by the same worker", async () => {
    const { store } = setup();
    await store.createAttempt(definition);
    const results = await Promise.all([
      store.claimAttempt(owner, "release-1", 1),
      store.claimAttempt({ ...owner, workerId: "duplicate-delivery" }, "release-1", 1),
      store.claimAttempt(owner, "release-1", 1),
    ]);
    expect(results).toEqual([true, false, false]);
    expect(await store.acceptAttemptBatch(owner, body(0, [started()]))).toEqual({
      accepted: true,
      runId: "root",
    });
  });

  it("grants one claim across genuinely concurrent worker connections", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tubeless-attempt-race-"));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const filename = join(directory, "history.sqlite");
    const { store } = setup(filename);
    await store.createAttempt(definition);
    const workers = [0, 1].map(
      (index) =>
        new Worker(
          `
      const { parentPort, workerData } = require("node:worker_threads");
      const { DatabaseSync } = require("node:sqlite");
      (async () => {
        const { SqliteHostedLaunchStore } = await import(workerData.module);
        const db = new DatabaseSync(workerData.filename);
        db.exec("PRAGMA busy_timeout = 5000");
        const storage = {
          sql: { exec(query, ...args) {
            const rows = db.prepare(query).all(...args);
            return { toArray: () => rows };
          } },
          transactionSync(fn) {
            db.exec("BEGIN IMMEDIATE");
            try { const result = fn(); db.exec("COMMIT"); return result; }
            catch (error) { db.exec("ROLLBACK"); throw error; }
          }
        };
        // Claims do not read or append trace events.
        const unusedEvents = { append() { throw new Error("Unexpected append"); },
          async listEvents() { return []; }, close() {} };
        const store = new SqliteHostedLaunchStore(storage, unusedEvents);
        parentPort.once("message", async () => {
          try { parentPort.postMessage(await store.claimAttempt(workerData.owner, "release-1", 1)); }
          catch (error) { throw error; }
          finally { db.close(); }
        });
        parentPort.postMessage("ready");
      })().catch((error) => { throw error; });
    `,
          {
            eval: true,
            workerData: {
              module: new URL("../../dist/hosting/launch-store-sqlite.js", import.meta.url).href,
              filename,
              owner: { ...owner, workerId: `worker-${index}` },
            },
          }
        )
    );
    for (const worker of workers)
      cleanup.push(async () => {
        await worker.terminate();
      });
    await Promise.all(
      workers.map(
        (worker) =>
          new Promise<void>((resolve, reject) => {
            worker.once("error", reject);
            worker.once("message", () => resolve());
          })
      )
    );
    const results = workers.map(
      (worker) =>
        new Promise<boolean>((resolve, reject) => {
          worker.once("error", reject);
          worker.once("message", resolve);
        })
    );
    for (const worker of workers) worker.postMessage("claim");
    const claims = await Promise.all(results);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const winner = { ...owner, workerId: `worker-${claims.indexOf(true)}` };
    expect(await store.acceptAttemptBatch(winner, body(0, [started()]))).toEqual({
      accepted: true,
      runId: "root",
    });
  });

  it("refuses mismatched code identity, launch, attempt, and closed launches", async () => {
    const { store } = setup();
    await store.createAttempt(definition);
    expect(await store.claimAttempt(owner, "another-release", 1)).toBe(false);
    expect(await store.claimAttempt({ ...owner, launchId: "other" }, "release-1", 1)).toBe(false);
    expect(await store.claimAttempt({ ...owner, attemptId: "other" }, "release-1", 1)).toBe(false);
    await store.fail(owner.launchId, "Host cancelled before dispatch", 2);
    expect(await store.claimAttempt(owner, "release-1", 3)).toBe(false);
    expect(await store.listEvents()).toEqual([]);
  });

  it("does not create an orphan launch or replace an attempt on provisioning conflicts", async () => {
    const { store, readLaunch } = await claimed();
    await expect(store.createAttempt({ ...definition, launchId: "orphan" })).rejects.toThrow();
    expect(readLaunch("orphan")).toBeUndefined();
    await expect(
      store.createAttempt({ ...definition, attemptId: "replacement" })
    ).rejects.toThrow();
    expect(await store.claimAttempt({ ...owner, attemptId: "replacement" }, "release-1", 2)).toBe(
      false
    );
    expect(await store.claimAttempt(owner, "release-1", 2)).toBe(false);
  });

  it("rolls back a claim if the launch admission update fails", async () => {
    const { store, storage, readLaunch } = setup();
    await store.createAttempt(definition);
    const exec = storage.sql.exec.bind(storage.sql);
    const fault = vi.spyOn(storage.sql, "exec").mockImplementation((query, ...args) => {
      if (query.startsWith("UPDATE tubeless_launches SET admitted"))
        throw new Error("admission write failed");
      return exec(query, ...args);
    });
    await expect(store.claimAttempt(owner, "release-1", 1)).rejects.toThrow(
      "admission write failed"
    );
    fault.mockRestore();
    expect(readLaunch(owner.launchId)?.admitted).toBe(0);
    expect(await store.claimAttempt({ ...owner, workerId: "retry" }, "release-1", 2)).toBe(true);
  });

  it("requires a claim and fences losing or mismatched writers", async () => {
    const { store } = setup();
    await store.createAttempt(definition);
    await expect(store.acceptAttemptBatch(owner, body(0, [started()]))).rejects.toMatchObject(
      conflict("ownership")
    );
    await store.claimAttempt(owner, "release-1", 1);
    for (const identity of [
      { ...owner, workerId: "loser" },
      { ...owner, launchId: "foreign" },
      { ...owner, attemptId: "foreign" },
    ])
      await expect(store.acceptAttemptBatch(identity, body(0, [started()]))).rejects.toMatchObject(
        conflict("ownership")
      );
    await expect(
      store.acceptAttemptBatch(owner, body(0, [started()], "foreign"))
    ).rejects.toMatchObject(conflict("ownership"));
    expect(await store.listEvents()).toEqual([]);
  });

  it("blocks ownerless ingest for an opted-in attempt", async () => {
    const { store } = await claimed();
    expect(await store.admit(owner.launchId)).toBe(false);
    await expect(store.acceptBatch(owner.launchId, 0, [started()])).rejects.toMatchObject(
      conflict("ownership")
    );
    expect(await store.listEvents()).toEqual([]);
  });

  it("revokes claims and writes without synthesizing a terminal outcome", async () => {
    const { store } = await claimed();
    const bytes = body(0, [started()]);
    await store.acceptAttemptBatch(owner, bytes);
    await store.revokeAttempt(owner.launchId, owner.attemptId);
    await store.revokeAttempt(owner.launchId, owner.attemptId);
    expect(await store.claimAttempt({ ...owner, workerId: "replacement" }, "release-1", 3)).toBe(
      false
    );
    await expect(store.acceptAttemptBatch(owner, bytes)).rejects.toMatchObject(
      conflict("ownership")
    );
    expect(await store.listEvents()).toHaveLength(1);
    expect(await store.liveRunIds()).toEqual(["root"]);
  });

  it("never grants a revoked pending attempt", async () => {
    const { store } = setup();
    await store.createAttempt(definition);
    await store.revokeAttempt(owner.launchId, owner.attemptId);
    expect(await store.claimAttempt(owner, "release-1", 1)).toBe(false);
  });

  it("persists claims, receipts and child ownership across close/reopen and competing connections", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tubeless-attempt-"));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const filename = join(directory, "history.sqlite");
    const first = await claimed(filename);
    const bytes = body(0, [started(), started("child", "root")]);
    await first.store.acceptAttemptBatch(owner, bytes);
    await first.store.close();
    const second = setup(filename);
    const competing = setup(filename);
    expect(await second.store.claimAttempt(owner, "release-1", 2)).toBe(false);
    expect(
      await competing.store.claimAttempt({ ...owner, workerId: "new-process" }, "release-1", 2)
    ).toBe(false);
    expect(await second.store.acceptAttemptBatch(owner, bytes)).toEqual({
      accepted: true,
      runId: "root",
    });
    const next = body(1, [log("child", "root")]);
    expect(
      await Promise.all([
        second.store.acceptAttemptBatch(owner, next),
        competing.store.acceptAttemptBatch(owner, next),
      ])
    ).toEqual([
      { accepted: true, runId: "root" },
      { accepted: true, runId: "root" },
    ]);
    expect(await second.store.listEvents()).toHaveLength(3);
  });
});

describe("atomic attempt batches", () => {
  it("returns identical committed acknowledgements and appends concurrent retries once", async () => {
    const { store } = await claimed();
    const bytes = body(0, [started()]);
    expect(
      await Promise.all(Array.from({ length: 4 }, () => store.acceptAttemptBatch(owner, bytes)))
    ).toEqual(Array.from({ length: 4 }, () => ({ accepted: true, runId: "root" })));
    await store.acceptAttemptBatch(owner, body(1, [completed()]));
    expect(await store.acceptAttemptBatch(owner, bytes)).toEqual({ accepted: true, runId: "root" });
    expect(await store.acceptAttemptBatch(owner, body(2, [log()]))).toEqual({ accepted: false });
    expect(await store.acceptAttemptBatch(owner, body(2, [log()]))).toEqual({ accepted: false });
    expect(await store.listEvents()).toHaveLength(2);
  });

  it("rejects altered content and byte-different retries, including after completion", async () => {
    const { store } = await claimed();
    const bytes = body(0, [started(), completed()]);
    await store.acceptAttemptBatch(owner, bytes);
    await expect(store.acceptAttemptBatch(owner, body(0, [started()]))).rejects.toMatchObject(
      conflict("replay")
    );
    const whitespace = new TextEncoder().encode(new TextDecoder().decode(bytes) + "\n");
    await expect(store.acceptAttemptBatch(owner, whitespace)).rejects.toMatchObject(
      conflict("replay")
    );
    expect(await store.listEvents()).toHaveLength(2);
  });

  it("rejects sequence gaps without recording receipts or consuming run ids", async () => {
    const { store } = await claimed();
    await expect(store.acceptAttemptBatch(owner, body(1, [started()]))).rejects.toMatchObject({
      ...conflict("sequence"),
      expectedSequence: 0,
    });
    expect(await store.acceptAttemptBatch(owner, body(0, [started()]))).toEqual({
      accepted: true,
      runId: "root",
    });
  });

  it.each(["event append", "receipt insert"])(
    "rolls back ownership, events and sequence if %s fails",
    async (stage) => {
      const { store, events, storage, readLaunch } = await claimed();
      const bytes = body(0, [started(), started("child", "root")]);
      const exec = storage.sql.exec.bind(storage.sql);
      const fault =
        stage === "event append"
          ? vi.spyOn(events, "append").mockImplementationOnce(() => {
              throw new Error("write failed");
            })
          : vi.spyOn(storage.sql, "exec").mockImplementation((query, ...args) => {
              if (query.startsWith("INSERT INTO tubeless_attempt_batches"))
                throw new Error("write failed");
              return exec(query, ...args);
            });
      await expect(store.acceptAttemptBatch(owner, bytes)).rejects.toThrow("write failed");
      fault.mockRestore();
      expect(await store.listEvents()).toEqual([]);
      expect(readLaunch(owner.launchId)).toMatchObject({ last_batch: -1, state: "starting" });
      for (const table of ["tubeless_attempt_runs", "tubeless_attempt_batches"])
        expect(storage.sql.exec(`SELECT * FROM ${table}`).toArray()).toEqual([]);
      expect(await store.acceptAttemptBatch(owner, bytes)).toEqual({
        accepted: true,
        runId: "root",
      });
      expect(await store.listEvents()).toHaveLength(2);
    }
  );

  it("keeps the owner identity stable across asynchronous hashing", async () => {
    const { store } = await claimed();
    const mutable = { ...owner };
    const accepting = store.acceptAttemptBatch(mutable, body(0, [started()]));
    mutable.workerId = "intruder";
    expect(await accepting).toEqual({ accepted: true, runId: "root" });
  });

  it("observes revocation that commits while the batch is being hashed", async () => {
    const { store } = await claimed();
    const accepting = store.acceptAttemptBatch(owner, body(0, [started()]));
    await store.revokeAttempt(owner.launchId, owner.attemptId);
    await expect(accepting).rejects.toMatchObject(conflict("ownership"));
    expect(await store.listEvents()).toEqual([]);
  });

  it("owns input bytes before asynchronous hashing", async () => {
    const { store } = await claimed();
    const bytes = body(0, [started()]);
    const original = bytes.slice();
    const accepting = store.acceptAttemptBatch(owner, bytes);
    bytes.fill(0);
    await accepting;
    expect(await store.acceptAttemptBatch(owner, original)).toEqual({
      accepted: true,
      runId: "root",
    });
  });
});

describe("run ownership", () => {
  it.each([
    ["wrong pipeline", [{ ...started(), pipelineId: "other" }]],
    ["second root", [started(), started("another-root")]],
    ["duplicate start", [started(), started()]],
    ["unknown parent", [started(), started("child", "foreign")]],
    ["child before parent", [started("child", "root"), started()]],
    ["event before start", [log(), started()]],
    ["wrong event pipeline", [started(), { ...log(), pipelineId: "other" }]],
    ["wrong event parent", [started(), log("root", "foreign")]],
  ] as const)("rejects %s and rolls back the whole batch", async (_label, events) => {
    const { store } = await claimed();
    await expect(store.acceptAttemptBatch(owner, body(0, events))).rejects.toMatchObject(
      conflict("events")
    );
    expect(await store.listEvents()).toEqual([]);
    expect(await store.acceptAttemptBatch(owner, body(0, [started()]))).toEqual({
      accepted: true,
      runId: "root",
    });
  });

  it("rejects a second root in a later batch without consuming its sequence", async () => {
    const { store } = await claimed();
    await store.acceptAttemptBatch(owner, body(0, [started()]));
    await expect(
      store.acceptAttemptBatch(owner, body(1, [started("replacement")]))
    ).rejects.toMatchObject(conflict("events"));
    expect(await store.acceptAttemptBatch(owner, body(1, [log()]))).toEqual({
      accepted: true,
      runId: "root",
    });
    expect(await store.listEvents()).toHaveLength(2);
  });

  it("rejects root theft, foreign parents and writes to another attempt's run", async () => {
    const { store } = await claimed();
    const other = { launchId: "l2", attemptId: "a2", workerId: "w2" };
    await store.createAttempt({ ...definition, ...other });
    await store.claimAttempt(other, "release-1", 1);
    await store.acceptAttemptBatch(owner, body(0, [started()]));
    for (const events of [[started()], [started("child", "root")], [log()]])
      await expect(
        store.acceptAttemptBatch(other, body(0, events, other.attemptId))
      ).rejects.toMatchObject(conflict("events"));
    expect(await store.listEvents()).toHaveLength(1);
  });

  it("refuses a run id already present in trusted history", async () => {
    const { store } = await claimed();
    await store.create("trusted", "command", 0);
    await store.acceptBatch("trusted", 0, [started()]);
    await expect(store.acceptAttemptBatch(owner, body(0, [started()]))).rejects.toMatchObject(
      conflict("events")
    );
    expect(await store.listEvents()).toHaveLength(1);
  });

  it("accepts real nested pipeline recordings with their definition snapshots", async () => {
    const { step, fromPipeline } = createSteps();
    const child = definePipeline({ id: "child", steps: [step("work", { run: () => 1 })] });
    const parent = definePipeline({
      id: "pipeline",
      steps: [fromPipeline("nested", { pipeline: child, mapOptions: () => ({}) })],
    });
    const recorded: PipelineTraceEvent[] = [];
    const result = await parent.run({}, undefined, {
      ...defaultPipelineContext(),
      tracing: {
        exporter: {
          export: (event) => {
            recorded.push(event);
          },
        },
      },
    });
    expect(result.status).toBe("completed");
    const { store } = await claimed();
    for (let offset = 0, sequence = 0; offset < recorded.length; offset += 50, sequence++)
      expect(
        await store.acceptAttemptBatch(owner, body(sequence, recorded.slice(offset, offset + 50)))
      ).toEqual({ accepted: true, runId: result.runId });
    expect((await store.listEvents()).map(({ id: _id, ...event }) => event)).toEqual(recorded);
  });

  it("adds attempt tables to existing stores without changing trusted run history", async () => {
    const { store, storage, events } = setup();
    await store.create("legacy", "pipeline", 0);
    await store.acceptBatch("legacy", 0, [started()]);
    for (const table of ["tubeless_attempt_runs", "tubeless_attempt_batches", "tubeless_attempts"])
      storage.sql.exec(`DROP TABLE ${table}`);
    const upgraded = new SqliteHostedLaunchStore(storage, events);
    expect(await upgraded.admit("legacy")).toBe(true);
    expect(await upgraded.acceptBatch("legacy", 1, [completed()])).toEqual({
      accepted: true,
      runId: "root",
    });
    expect(await upgraded.listEvents()).toHaveLength(2);
    await upgraded.createAttempt({ ...definition, launchId: "new" });
    expect(await upgraded.claimAttempt({ ...owner, launchId: "new" }, "release-1", 1)).toBe(true);
  });

  it("uses the same atomic operations with Durable Object SQL constraints", async () => {
    const storage = createFakeDurableStorage();
    const events = openDurableRunStore(storage);
    const store = new SqliteHostedLaunchStore(storage, events);
    await store.createAttempt(definition);
    expect(await store.claimAttempt(owner, "release-1", 1)).toBe(true);
    const bytes = body(0, [started(), completed()]);
    expect(await store.acceptAttemptBatch(owner, bytes)).toEqual({ accepted: true, runId: "root" });
    const reopened = new SqliteHostedLaunchStore(storage, openDurableRunStore(storage));
    expect(await reopened.claimAttempt(owner, "release-1", 2)).toBe(false);
    expect(await reopened.acceptAttemptBatch(owner, bytes)).toEqual({
      accepted: true,
      runId: "root",
    });
    expect(await reopened.listEvents()).toHaveLength(2);
  });
});

it.each([
  { attemptId: "attempt", sequence: -1, events: [started()] },
  { attemptId: "attempt", sequence: 0.5, events: [started()] },
  { attemptId: "attempt", sequence: Number.MAX_SAFE_INTEGER + 1, events: [started()] },
  { attemptId: "attempt", sequence: 0, events: [] },
  { attemptId: "attempt", sequence: 0, events: Array.from({ length: 51 }, () => started()) },
  { attemptId: "attempt", sequence: 0, events: [{ ...started(), version: 2 }] },
  { attemptId: "attempt", sequence: 0, events: [{ ...started(), payload: {} }] },
  { attemptId: "attempt", sequence: 0, events: [started()], extra: true },
])("rejects malformed attempt envelopes without writes (%#)", async (input) => {
  const { store } = await claimed();
  await expect(
    store.acceptAttemptBatch(owner, new TextEncoder().encode(JSON.stringify(input)))
  ).rejects.toThrow();
  expect(await store.listEvents()).toEqual([]);
  expect(await store.acceptAttemptBatch(owner, body(0, [started()]))).toEqual({
    accepted: true,
    runId: "root",
  });
});

it("rejects oversized bodies and invalid UTF-8 without writes", async () => {
  const { store } = await claimed();
  await expect(store.acceptAttemptBatch(owner, new Uint8Array(1_048_577))).rejects.toThrow(
    "too large"
  );
  await expect(store.acceptAttemptBatch(owner, new Uint8Array([0xff]))).rejects.toThrow();
  expect(await store.listEvents()).toEqual([]);
});
