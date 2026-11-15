import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SqliteHostedLaunchStore } from "./launch-store-sqlite.js";
import { createSqliteLaunchStoreFixture } from "./launch-store-sqlite.test-support.js";
import {
  collectorFixture,
  started,
  completed,
  log,
  batch,
  failure,
} from "./collector.test-support.js";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.reverse()) await close();
  cleanup.length = 0;
});
async function setup(filename?: string) {
  const fixture = await collectorFixture(filename);
  cleanup.push(() => fixture.store.close());
  expect(await fixture.store.claimCollectorAttempt(fixture.authority, "worker", "release-1")).toBe(
    true
  );
  return fixture;
}

describe("authenticated collector persistence", () => {
  it.each(["expiry", "revocation"])(
    "rechecks %s after hashing before any batch or replay commits",
    async (mode) => {
      const { store, authority, clock, events, readLaunch } = await setup();
      const bytes = batch(0, [started()]);
      const pending = store.acceptCollectorBatch(authority, "worker", bytes);
      if (mode === "expiry") clock.now = 1000;
      else await store.revokeAttempt("launch", "attempt");
      await expect(pending).rejects.toThrow("authority");
      expect(await events.listEvents()).toEqual([]);
      expect(readLaunch("launch")?.last_batch).toBe(-1);
    }
  );

  it("rejects expiry for failure reports, including accepted report retries", async () => {
    const { store, authority, clock, events } = await setup();
    await store.acceptCollectorBatch(authority, "worker", batch(0, [started()]));
    const pending = store.reportCollectorFailure(authority, "worker", failure());
    clock.now = 1000;
    await expect(pending).rejects.toThrow("authority");
    expect(await events.listEvents()).toHaveLength(1);
    clock.now = 999;
    expect(await store.reportCollectorFailure(authority, "worker", failure())).toBe(true);
    clock.now = 1000;
    await expect(store.reportCollectorFailure(authority, "worker", failure())).rejects.toThrow(
      "authority"
    );
  });

  it("closes an exited worker's open subtree once, preserves exact receipts, and never overwrites success", async () => {
    const { store, authority, events } = await setup();
    const bytes = batch(0, [started(), started("child", "root"), started("grandchild", "child")]);
    await store.acceptCollectorBatch(authority, "worker", bytes);
    expect(await store.reportCollectorFailure(authority, "worker", failure())).toBe(true);
    expect(await store.reportCollectorFailure(authority, "worker", failure())).toBe(true);
    const stored = await events.listEvents();
    expect(
      stored.filter((event) => event.name === "pipeline.completed").map((event) => event.runId)
    ).toEqual(["grandchild", "child", "root"]);
    expect(stored.at(-1)).toMatchObject({
      payload: { status: "failed" },
      error: { message: "Worker exited" },
    });
    await expect(
      store.reportCollectorFailure(authority, "worker", failure("different"))
    ).rejects.toMatchObject({ code: "replay" });
    expect(
      await store.reportCollectorFailure(authority, "worker", failure("another report", "other"))
    ).toBe(false);
    expect(await store.acceptCollectorBatch(authority, "worker", bytes)).toEqual({
      accepted: true,
      runId: "root",
    });
    expect(await store.acceptCollectorBatch(authority, "worker", batch(1, [log()]))).toEqual({
      accepted: false,
    });
    expect(await events.listEvents()).toHaveLength(6);
  });

  it("records false after completion without changing the successful terminal event", async () => {
    const { store, authority, events } = await setup();
    await store.acceptCollectorBatch(authority, "worker", batch(0, [started(), completed()]));
    expect(await store.reportCollectorFailure(authority, "worker", failure())).toBe(false);
    expect(await store.reportCollectorFailure(authority, "worker", failure())).toBe(false);
    expect(await events.listEvents()).toMatchObject([started(), completed()]);
  });

  it("closes failures before root start without inventing history", async () => {
    const { store, authority, events, readLaunch } = await setup();
    expect(await store.reportCollectorFailure(authority, "worker", failure())).toBe(true);
    expect(readLaunch("launch")?.state).toBe("failed");
    expect(await events.listEvents()).toEqual([]);
    expect(await store.acceptCollectorBatch(authority, "worker", batch(0, [started()]))).toEqual({
      accepted: false,
    });
  });

  it("rolls back synthetic completions and state if failure receipt insertion fails", async () => {
    const { store, authority, events, storage, readLaunch } = await setup();
    await store.acceptCollectorBatch(
      authority,
      "worker",
      batch(0, [started(), started("child", "root")])
    );
    storage.sql.exec(
      "CREATE TRIGGER fail_receipt BEFORE INSERT ON tubeless_attempt_failures BEGIN SELECT RAISE(ABORT, 'injected failure'); END"
    );
    await expect(store.reportCollectorFailure(authority, "worker", failure())).rejects.toThrow(
      "injected failure"
    );
    expect(await events.listEvents()).toHaveLength(2);
    expect(readLaunch("launch")?.state).toBe("running");
    storage.sql.exec("DROP TRIGGER fail_receipt");
    expect(await store.reportCollectorFailure(authority, "worker", failure())).toBe(true);
    expect(await events.listEvents()).toHaveLength(4);
  });

  it("persists credential, batch and failure receipts across collector restarts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tubeless-collector-"));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const filename = join(directory, "history.sqlite");
    const first = await setup(filename);
    const bytes = batch(0, [started()]);
    await first.store.acceptCollectorBatch(first.authority, "worker", bytes);
    await first.store.reportCollectorFailure(first.authority, "worker", failure());
    first.store.close();
    const second = createSqliteLaunchStoreFixture(filename);
    const store = new SqliteHostedLaunchStore(second.storage, second.events, () => 101);
    cleanup.push(() => store.close());
    expect(await store.getCollectorCredential("launch", first.authority.credentialId)).toEqual(
      first.authority
    );
    expect(await store.acceptCollectorBatch(first.authority, "worker", bytes)).toEqual({
      accepted: true,
      runId: "root",
    });
    expect(await store.reportCollectorFailure(first.authority, "worker", failure())).toBe(true);
    expect(await second.events.listEvents()).toHaveLength(2);
    await store.revokeAttempt("launch", "attempt");
    await expect(store.acceptCollectorBatch(first.authority, "worker", bytes)).rejects.toThrow(
      "authority"
    );
  });
});
