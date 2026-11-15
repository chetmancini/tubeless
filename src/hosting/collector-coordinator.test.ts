import { afterEach, describe, expect, it, vi } from "vitest";
import { createCollectorHostedRun, type CollectorDispatch } from "./collector-coordinator.js";
import { createSqliteLaunchStoreFixture } from "./launch-store-sqlite.test-support.js";
import { commands } from "./run.test-support.js";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.reverse()) await close();
  cleanup.length = 0;
  vi.useRealTimers();
  vi.restoreAllMocks();
});
function setup() {
  const fixture = createSqliteLaunchStoreFixture();
  cleanup.push(() => fixture.store.close());
  const start = vi.fn(async (_packet: CollectorDispatch) => {});
  const options = {
    store: fixture.store,
    commands: new Map(commands),
    deploymentId: "revision",
    maxRunDurationMs: 1000,
    credentialTtlMs: 60_000,
    startTimeoutMs: 10,
    output: { cwd: "/tmp", stdout: { write() {} }, stderr: { write() {} } },
    start,
  };
  const hosted = createCollectorHostedRun(options);
  cleanup.push(() => hosted.launcher.close());
  return { ...fixture, ...hosted, start, options };
}

describe("owned launch preparation and dispatch", () => {
  it("accepts inherited configuration and dispatch methods with their original receiver", async () => {
    vi.useFakeTimers();
    const { options, start, storage } = setup();
    class Configuration {
      store = options.store;
      commands = options.commands;
      output = options.output;
      maxRunDurationMs = options.maxRunDurationMs;
      startTimeoutMs = options.startTimeoutMs;
      credentialTtlMs = options.credentialTtlMs;
      calls = 0;
      get deploymentId() {
        return "inherited-revision";
      }
      async start(packet: CollectorDispatch) {
        this.calls++;
        await start(packet);
      }
    }
    const config = new Configuration();
    const { launcher } = createCollectorHostedRun(config);
    cleanup.push(() => launcher.close());
    const result = launcher.launch("greeting", { name: "Ada" });
    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
    expect(config.calls).toBe(1);
    expect(storage.sql.exec("SELECT deployment_id FROM tubeless_attempts").toArray()).toEqual([
      { deployment_id: "inherited-revision" },
    ]);
    await vi.advanceTimersByTimeAsync(10);
    await result;
  });

  it("retains configured deployment, credentials, dispatch and catalog after caller mutation", async () => {
    vi.useFakeTimers();
    const { launcher, start, options, storage } = setup();
    const replacement = vi.fn(async (_packet: CollectorDispatch) => {});
    options.deploymentId = "changed";
    options.credentialTtlMs = 0;
    options.start = replacement;
    options.commands.clear();
    const result = launcher.launch("greeting", { name: "Ada" });
    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
    expect(replacement).not.toHaveBeenCalled();
    expect(storage.sql.exec("SELECT deployment_id FROM tubeless_attempts").toArray()).toEqual([
      { deployment_id: "revision" },
    ]);
    await vi.advanceTimersByTimeAsync(10);
    await result;
  });

  it("owns submitted input while provisioning and waits for a committed start acknowledgement", async () => {
    vi.useFakeTimers();
    const { launcher, start } = setup();
    const values = { name: "Ada" };
    const result = launcher.launch("greeting", values);
    values.name = "changed";
    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
    const packet = start.mock.calls[0]![0];
    expect(packet.job.values).toEqual({ name: "Ada" });
    expect(packet.token).toMatch(/^[a-f0-9]{32}\.[a-f0-9]{64}$/);
    await vi.advanceTimersByTimeAsync(10);
    expect(await result).toMatchObject({ accepted: false });
    expect(start).toHaveBeenCalledOnce();
  });

  it("settles close during provisioning and never dispatches the late prepared job", async () => {
    const { launcher, store, start, storage } = setup();
    const provision = store.provisionCollectorAttempt.bind(store);
    let ready!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(store, "provisionCollectorAttempt").mockImplementation(async (...args) => {
      ready();
      await held;
      await provision(...args);
    });
    const result = launcher.launch("greeting", { name: "Ada" });
    await entered;
    const closing = launcher.close();
    expect(await result).toMatchObject({ accepted: false });
    release();
    await closing;
    expect(start).not.toHaveBeenCalled();
    expect(storage.sql.exec("SELECT state FROM tubeless_launches").toArray()).toEqual([
      { state: "failed" },
    ]);
  });

  it("protects admitted execution from an uncertain dispatch reply and sanitizes errors", async () => {
    vi.useFakeTimers();
    const { launcher, start, store, readLaunch } = setup();
    start.mockImplementation(async ({ job, token }) => {
      const authority = (await store.getCollectorCredential(job.launchId, token.slice(0, 32)))!;
      await store.claimCollectorAttempt(authority, "worker", "revision");
      throw new Error(`PRIVATE ${token}`);
    });
    const result = launcher.launch("greeting", { name: "Ada" });
    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
    await launcher.drain();
    expect(JSON.stringify(await result)).not.toContain("PRIVATE");
    const job = start.mock.calls[0]![0].job;
    expect(readLaunch(job.launchId)).toMatchObject({ admitted: 1, state: "starting" });
  });
});
