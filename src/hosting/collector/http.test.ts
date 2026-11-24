import { afterEach, describe, expect, it, vi } from "vitest";
import { provisionCollectorAttempt, verifyCollectorCredential } from "./credentials.js";
import {
  collectorFixture,
  definition,
  encode,
  batch,
  started,
  completed,
  failure,
} from "./fixture.test-support.js";

const cleanup: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0)) close();
});
async function setup() {
  const fixture = await collectorFixture();
  cleanup.push(() => fixture.store.close());
  return fixture;
}
const claim = encode({ attemptId: "attempt", deploymentId: "release-1" });
const claimed = async () => {
  const fixture = await setup();
  expect(await (await fixture.send("admit", claim)).json()).toEqual({ admitted: true });
  return fixture;
};

describe("collector credentials", () => {
  it("persists a verifier, binds all scope and validity fields, and expires at the boundary", async () => {
    const { storage, token, authority, store } = await setup();
    const rows = storage.sql.exec("SELECT * FROM tubeless_collector_credentials").toArray();
    expect(JSON.stringify(rows)).not.toContain(token.slice(33));
    expect(await verifyCollectorCredential(token, authority, 100)).toBe(true);
    for (const now of [99, 1000])
      expect(await verifyCollectorCredential(token, authority, now)).toBe(false);
    for (const change of [
      { launchId: "other" },
      { attemptId: "other" },
      { expiresAtMs: 2000 },
      { notBeforeMs: 0 },
    ])
      expect(await verifyCollectorCredential(token, { ...authority, ...change }, 100)).toBe(false);
    const altered = `${token.slice(0, -1)}${token.endsWith("0") ? "1" : "0"}`;
    expect(await verifyCollectorCredential(altered, authority, 100)).toBe(false);
    await store.revokeAttempt("launch", "attempt");
    expect(await store.getCollectorCredential("launch", authority.credentialId)).toBeUndefined();
  });

  it("rolls back attempt creation when credential persistence fails", async () => {
    const { store, authority, readLaunch } = await setup();
    await expect(
      store.provisionCollectorAttempt(
        { ...definition, launchId: "other", attemptId: "other" },
        authority
      )
    ).rejects.toThrow();
    expect(readLaunch("other")).toBeUndefined();
    await expect(
      provisionCollectorAttempt(store, { ...definition, launchId: "new", attemptId: "new" }, 99)
    ).rejects.toThrow();
    expect(readLaunch("new")).toBeUndefined();
  });
});

describe("Fetch-native collector", () => {
  it("rejects unknown operations before reading bodies or accessing storage", async () => {
    const { send, store } = await setup();
    const lookup = vi.spyOn(store, "getCollectorCredential");
    const report = vi.spyOn(store, "reportCollectorFailure");
    for (const operation of ["unknown", "constructor", "toString", "__proto__", "admit/extra"]) {
      const read = vi.fn();
      const cancel = vi.fn();
      const response = await send(
        operation,
        new ReadableStream<Uint8Array>({ pull: read, cancel }, { highWaterMark: 0 })
      );
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ code: "not_found" });
      expect(read).not.toHaveBeenCalled();
      expect(cancel).toHaveBeenCalledOnce();
    }
    expect(lookup).not.toHaveBeenCalled();
    expect(report).not.toHaveBeenCalled();
  });

  it.each(["missing", "wrong-secret", "other-launch", "expired", "revoked"])(
    "authenticates %s before reading a body",
    async (mode) => {
      const { send, token, store, clock } = await setup();
      if (mode === "expired") clock.now = 1000;
      if (mode === "revoked") await store.revokeAttempt("launch", "attempt");
      const read = vi.fn();
      const cancel = vi.fn();
      const body = new ReadableStream<Uint8Array>({ pull: read, cancel }, { highWaterMark: 0 });
      const authorization =
        mode === "missing"
          ? ""
          : mode === "wrong-secret"
            ? `Bearer ${token.slice(0, 33)}${"0".repeat(64)}`
            : `Bearer ${token}`;
      const response = await send(
        "admit",
        body,
        { authorization },
        mode === "other-launch" ? "other" : "launch"
      );
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ code: "unauthorized" });
      expect(read).not.toHaveBeenCalled();
      expect(cancel).toHaveBeenCalledOnce();
    }
  );

  it("grants execution only once and rejects a mismatched attempt or release", async () => {
    const { send } = await setup();
    expect(
      (await send("admit", encode({ attemptId: "other", deploymentId: "release-1" }))).status
    ).toBe(401);
    expect(
      await (await send("admit", encode({ attemptId: "attempt", deploymentId: "other" }))).json()
    ).toEqual({ admitted: false });
    expect(await (await send("admit", claim)).json()).toEqual({ admitted: true });
    expect(await (await send("admit", claim)).json()).toEqual({ admitted: false });
  });

  it.each(["expiry", "revocation"])(
    "rechecks %s after authentication and body reading",
    async (mode) => {
      const { send, clock, store, readLaunch } = await setup();
      const body = new ReadableStream<Uint8Array>(
        {
          async pull(controller) {
            if (mode === "expiry") clock.now = 1000;
            else await store.revokeAttempt("launch", "attempt");
            controller.enqueue(claim);
            controller.close();
          },
        },
        { highWaterMark: 0 }
      );
      expect((await send("admit", body)).status).toBe(401);
      expect(readLaunch("launch")?.admitted).toBe(0);
    }
  );

  it("bounds real bytes even without or with a false content length, and cancels the stream", async () => {
    const { send } = await setup();
    for (const headers of [new Headers(), new Headers({ "content-length": "1" })]) {
      const cancel = vi.fn();
      const stream = new ReadableStream<Uint8Array>({
        pull(c) {
          c.enqueue(new Uint8Array(8193));
        },
        cancel,
      });
      expect((await send("admit", stream, headers)).status).toBe(413);
      expect(cancel).toHaveBeenCalledOnce();
    }
    expect((await send("admit", claim, { "content-length": "999999" })).status).toBe(413);
    expect((await send("admit", claim, { "content-type": "text/plain" })).status).toBe(415);
  });

  it("rejects malformed, unknown-field, unsupported-version and mis-scoped input without leaking data", async () => {
    const { send, events } = await claimed();
    for (const body of [
      encode({ attemptId: "attempt", deploymentId: "release-1", secret: "private" }),
      new Uint8Array([255]),
      encode([]),
    ]) {
      const response = await send("admit", body);
      expect(response.status).toBe(400);
      expect(await response.text()).not.toContain("private");
    }
    expect((await send("batches", batch(0, [{ ...started(), version: 2 } as never]))).status).toBe(
      400
    );
    expect(
      (await send("batches", encode({ attemptId: "other", sequence: 0, events: [started()] })))
        .status
    ).toBe(401);
    expect(await events.listEvents()).toEqual([]);
  });

  it("returns scoped conflicts and durable acknowledgements without exposing a browser capability", async () => {
    const { send, events } = await claimed();
    expect((await send("batches", batch(1, [started()]))).status).toBe(409);
    const bytes = batch(0, [started(), completed()]);
    for (let i = 0; i < 2; i++) {
      const response = await send("batches", bytes);
      expect(await response.json()).toEqual({ accepted: true, runId: "root" });
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
    }
    expect(
      (await send("batches", new TextEncoder().encode(` ${new TextDecoder().decode(bytes)}`)))
        .status
    ).toBe(409);
    expect((await send("batches", batch(1, [completed()]))).status).toBe(410);
    expect(await events.listEvents()).toHaveLength(2);
  });

  it("requires the claiming worker for failure reports and does not disclose storage errors", async () => {
    const { send, store, events, collector } = await claimed();
    await send("batches", batch(0, [started()]));
    expect((await send("failure", failure(), { "x-tubeless-worker-id": "another" })).status).toBe(
      401
    );
    expect(await events.listEvents()).toHaveLength(1);
    vi.spyOn(store, "getCollectorCredential").mockRejectedValue(
      new Error("SECRET storage details")
    );
    const response = await send("admit", claim);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("SECRET");
    expect((await collector.fetch(new Request("https://collector.test/unknown"))).status).toBe(404);
  });

  it("bounds stalled bodies using request cancellation even when cancellation itself hangs", async () => {
    const { collector, token } = await setup();
    const controller = new AbortController();
    let startedRead!: () => void;
    const reading = new Promise<void>((resolve) => {
      startedRead = resolve;
    });
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const request = new Request("https://collector.test/v1/launches/launch/admit", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-tubeless-worker-id": "worker",
      },
      body: new ReadableStream<Uint8Array>(
        {
          pull() {
            startedRead();
          },
          cancel,
        },
        { highWaterMark: 0 }
      ),
      signal: controller.signal,
      ...{ duplex: "half" },
    });
    const pending = collector.fetch(request);
    await reading;
    controller.abort();
    expect((await pending).status).toBe(408);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("bounds a stalled authority lookup without reading the body and observes late failure", async () => {
    const { collector, store, token } = await setup();
    const abort = new AbortController();
    let reject!: (cause: Error) => void;
    vi.spyOn(store, "getCollectorCredential").mockImplementation(
      () =>
        new Promise((_, fail) => {
          reject = fail;
        })
    );
    const read = vi.fn();
    const pending = collector.fetch(
      new Request("https://collector.test/v1/launches/launch/admit", {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: new ReadableStream<Uint8Array>({ pull: read }, { highWaterMark: 0 }),
        signal: abort.signal,
        ...{ duplex: "half" },
      })
    );
    abort.abort();
    expect((await pending).status).toBe(408);
    expect(read).not.toHaveBeenCalled();
    reject(new Error("late private storage detail"));
    await Promise.resolve();
  });
});
