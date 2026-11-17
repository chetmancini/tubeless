import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSqliteLaunchStoreFixture } from "./launch-store-sqlite.test-support.js";
import { SqliteHostedLaunchStore } from "./launch-store-sqlite.js";
import { createCollectorTransport } from "./collector-transport.js";
import { collectorFixture, batch, completed, encode, started } from "./collector.test-support.js";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.reverse()) await close();
  cleanup.length = 0;
});
async function setup(filename?: string) {
  const fixture = await collectorFixture(filename);
  cleanup.push(() => fixture.store.close());
  return fixture;
}
const control = encode({ attemptId: "attempt" });

describe("durable owned-attempt cancellation", () => {
  it("fences claims before execution without inventing terminal history", async () => {
    const { store, authority, events, readLaunch } = await setup();
    for (let i = 0; i < 2; i++)
      expect(await store.requestAttemptCancellation("launch", "attempt")).toBe(true);
    for (const worker of ["worker", "redelivery"])
      expect(await store.claimCollectorAttempt(authority, worker, "release-1")).toBe(false);
    expect(readLaunch("launch")).toMatchObject({ admitted: 0, state: "starting" });
    expect(await events.listEvents()).toEqual([]);
    await expect(store.collectorCancellationRequested(authority, "worker")).rejects.toMatchObject({
      code: "ownership",
    });
  });

  it("scopes requests to an open owned attempt and preserves successful history", async () => {
    const { store, authority, events } = await setup();
    await store.create("trusted", "command", 100);
    for (const [launchId, attemptId] of [
      ["other", "attempt"],
      ["launch", "other"],
      ["trusted", "attempt"],
    ] as const)
      expect(await store.requestAttemptCancellation(launchId, attemptId)).toBe(false);
    await store.claimCollectorAttempt(authority, "worker", "release-1");
    expect(await store.collectorCancellationRequested(authority, "worker")).toBe(false);
    await store.acceptCollectorBatch(authority, "worker", batch(0, [started(), completed()]));
    const history = await events.listEvents();
    expect(await store.requestAttemptCancellation("launch", "attempt")).toBe(false);
    expect(await events.listEvents()).toEqual(history);
  });

  it("retains intent across a database reopen while allowing final history to drain", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tubeless-cancellation-"));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const filename = join(directory, "history.sqlite");
    const first = await setup(filename);
    await first.store.claimCollectorAttempt(first.authority, "worker", "release-1");
    const bytes = batch(0, [started()]);
    await first.store.acceptCollectorBatch(first.authority, "worker", bytes);
    expect(await first.store.requestAttemptCancellation("launch", "attempt")).toBe(true);
    expect(first.readLaunch("launch")?.state).toBe("running");
    expect(await first.events.listEvents()).toMatchObject([started()]);
    await first.store.close();
    const reopened = createSqliteLaunchStoreFixture(filename);
    const store = new SqliteHostedLaunchStore(reopened.storage, reopened.events, () => 101);
    cleanup.push(() => store.close());
    expect(await store.collectorCancellationRequested(first.authority, "worker")).toBe(true);
    expect(await store.requestAttemptCancellation("launch", "attempt")).toBe(true);
    expect(await store.acceptCollectorBatch(first.authority, "worker", bytes)).toEqual({
      accepted: true,
      runId: "root",
    });
    expect(
      await store.acceptCollectorBatch(first.authority, "worker", batch(1, [completed()]))
    ).toEqual({ accepted: true, runId: "root" });
    expect(await store.requestAttemptCancellation("launch", "attempt")).toBe(false);
  });

  it("rolls back a failed cancellation write without fencing admission", async () => {
    const { store, storage, authority } = await setup();
    storage.sql.exec(
      "CREATE TRIGGER fail_cancel BEFORE INSERT ON tubeless_attempt_cancellations BEGIN SELECT RAISE(ABORT, 'cancel failed'); END"
    );
    await expect(store.requestAttemptCancellation("launch", "attempt")).rejects.toThrow(
      "cancel failed"
    );
    expect(await store.claimCollectorAttempt(authority, "worker", "release-1")).toBe(true);
    expect(await store.collectorCancellationRequested(authority, "worker")).toBe(false);
  });
});

describe("authenticated cancellation control", () => {
  it("authenticates before reading and bounds control request bodies", async () => {
    const { send } = await setup();
    const read = vi.fn();
    const cancel = vi.fn();
    expect(
      (
        await send(
          "control",
          new ReadableStream<Uint8Array>({ pull: read, cancel }, { highWaterMark: 0 }),
          { authorization: "" }
        )
      ).status
    ).toBe(401);
    expect(read).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
    expect((await send("control", new Uint8Array(8193))).status).toBe(413);
    expect((await send("control", control, { "content-length": "8193" })).status).toBe(413);
    expect((await send("control", new Uint8Array([255]))).status).toBe(400);
  });

  it("requires the owner and exact attempt, and never accepts cancellation writes", async () => {
    const { send, store, authority } = await setup();
    expect((await send("control", control)).status).toBe(401);
    await store.claimCollectorAttempt(authority, "worker", "release-1");
    expect(await (await send("control", control)).json()).toEqual({ cancelRequested: false });
    expect((await send("control", control, { "x-tubeless-worker-id": "other" })).status).toBe(401);
    expect((await send("control", encode({ attemptId: "other" }))).status).toBe(401);
    expect(
      (await send("control", encode({ attemptId: "attempt", cancelRequested: true }))).status
    ).toBe(400);
    expect(await store.collectorCancellationRequested(authority, "worker")).toBe(false);
    await store.requestAttemptCancellation("launch", "attempt");
    const response = await send("control", control);
    expect(await response.json()).toEqual({ cancelRequested: true });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it.each(["expiry", "revocation"])("rechecks %s after reading a control request", async (mode) => {
    const { store, authority, clock, send } = await setup();
    await store.claimCollectorAttempt(authority, "worker", "release-1");
    const body = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          if (mode === "expiry") clock.now = 1000;
          else await store.revokeAttempt("launch", "attempt");
          controller.enqueue(control);
          controller.close();
        },
      },
      { highWaterMark: 0 }
    );
    expect((await send("control", body)).status).toBe(401);
    await expect(store.collectorCancellationRequested(authority, "worker")).rejects.toThrow(
      "authority"
    );
  });

  it("retries a lost control reply without changing scope or admission", async () => {
    const { store, collector, authority, token, readLaunch } = await setup();
    await store.claimCollectorAttempt(authority, "worker", "release-1");
    await store.requestAttemptCancellation("launch", "attempt");
    const bodies: Uint8Array[] = [];
    const transport = createCollectorTransport({
      baseUrl: "https://collector.test",
      launchId: "launch",
      workerId: "worker",
      token,
      fetch: async (input, init) => {
        bodies.push(new Uint8Array(init!.body as Uint8Array));
        const response = await collector.fetch(new Request(input, init));
        if (bodies.length === 1) throw new TypeError("lost reply");
        return response;
      },
    });
    expect(await transport.cancellationRequested("attempt")).toEqual({ cancelRequested: true });
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toEqual(bodies[1]);
    expect(readLaunch("launch")).toMatchObject({ admitted: 1, state: "starting" });
  });
});
