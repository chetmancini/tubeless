import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commands, sideEffect } from "../hosting/run.test-support.js";
import type { RunJob } from "../hosting/run-contract.js";
import { openDurableRunStore } from "./cloudflare-run-store.js";
import { RunObjectCore } from "./cloudflare-run.js";
import { createFakeDurableStorage } from "./cloudflare-storage.test-support.js";
import { StudioObjectCore } from "./cloudflare-studio.js";
import type { CloudflareLaunchValues } from "./cloudflare.js";
import { createSteps, definePipeline } from "../core/pipeline.js";
import { definePipelineCommand } from "../cli/cli-pipeline-command.js";
import { defineProject } from "../project/project.js";
import { hostedProjectCommands } from "../hosting/hosting-commands.js";
import { launchInputPolicy } from "../hosting/launch-metadata.js";
import type {
  LaunchInputPolicy,
  LaunchAttribution,
  StudioLaunchMetadata,
} from "../studio/shared/launch-metadata.js";

function setup(
  options: {
    storage?: ReturnType<typeof createFakeDurableStorage>;
    deploymentId?: string;
    now?: () => number;
    start?: (job: RunJob, run: RunObjectCore) => Promise<void>;
    commands?: typeof commands;
    maxRunDurationMs?: number;
    recordInputs?: LaunchInputPolicy;
  } = {}
) {
  const storage = options.storage ?? createFakeDurableStorage();
  const deploymentId = options.deploymentId ?? "release-1";
  const catalog = options.commands ?? commands;
  const runs = new Map<string, RunObjectCore>();
  let studio!: StudioObjectCore;
  const start = vi.fn(async (job: RunJob) => {
    const run = new RunObjectCore({
      storage: createFakeDurableStorage(),
      commands: catalog,
      deploymentId,
      ingest: () => studio,
    });
    runs.set(job.launchId, run);
    if (options.start) await options.start(job, run);
    else await run.start(job);
  });
  studio = new StudioObjectCore({
    storage,
    commands: catalog,
    projectId: "p",
    deploymentId,
    clientScript: "",
    maxRunDurationMs: options.maxRunDurationMs ?? 60_000,
    now: options.now,
    inputPolicy: launchInputPolicy(catalog, options.recordInputs),
    runStub: () => ({ start, cancel: () => false }),
  });
  const launch = (
    idempotencyKey = "daily.1",
    values: CloudflareLaunchValues = { name: "Ada" },
    commandId = "effect",
    context?: LaunchAttribution
  ) => studio.launch({ commandId, values, idempotencyKey, projectId: "p", deploymentId, context });
  return { studio, storage, start, runs, launch };
}

beforeEach(() => {
  sideEffect.mockClear();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("Cloudflare programmatic launch admission", () => {
  it("records only opted-in normalized inputs and preserves the first actor on replay and restart", async () => {
    const first = setup({ recordInputs: { effect: ["name", "dryRun"] } });
    const context = {
      actor: { id: "cron", kind: "service" as const },
      trigger: "schedule" as const,
    };
    const receipt = await first.launch("history.1", { name: "Ada" }, "effect", context);
    if (!receipt.accepted) throw new Error("Expected admission");
    await first.runs.get(receipt.launchId)!.alarm();
    const status = await first.studio.getLaunch(receipt.launchId);
    const detail = async (studio: StudioObjectCore) =>
      (await (
        await studio.fetch(new Request(`https://studio.example/api/runs/${status!.runId}`))
      ).json()) as { launch: StudioLaunchMetadata };
    expect((await detail(first.studio)).launch).toMatchObject({
      launchId: receipt.launchId,
      commandId: "effect",
      deploymentId: "release-1",
      actor: context.actor,
      trigger: "schedule",
      inputs: {
        recorded: expect.arrayContaining([
          expect.objectContaining({ key: "name", value: "Ada" }),
          expect.objectContaining({ key: "dryRun", value: false }),
        ]),
      },
    });
    const reopened = setup({ storage: first.storage });
    expect(
      await reopened.launch("history.1", { name: "Ada" }, "effect", {
        actor: { id: "someone-else", kind: "user" },
        trigger: "queue",
      })
    ).toEqual(receipt);
    expect((await detail(reopened.studio)).launch.actor).toEqual(context.actor);
    expect(reopened.start).not.toHaveBeenCalled();
    expect(
      (
        await reopened.launch("invalid-context", { name: "Ada" }, "effect", {
          trigger: "forged" as never,
        })
      ).accepted
    ).toBe(false);
  });

  it("defaults to recording no values and clears metadata without deleting admission receipts", async () => {
    const { studio, storage, launch, runs } = setup();
    const receipt = await launch("private", { name: "never-save-this" });
    if (!receipt.accepted) throw new Error("Expected admission");
    const rows = () => storage.sql.exec("SELECT * FROM tubeless_launch_metadata").toArray();
    expect(JSON.stringify(rows())).not.toContain("never-save-this");
    expect(JSON.parse(String(rows()[0]!.metadata_json)).inputs.recorded).toEqual([]);
    const clear = () =>
      studio.fetch(
        new Request("https://studio.example/api/history", {
          method: "DELETE",
          headers: { origin: "https://studio.example", "x-tubeless-studio-clear-history": "1" },
        })
      );
    expect((await clear()).status).toBe(409);
    expect(rows()).toHaveLength(1);
    await runs.get(receipt.launchId)!.alarm();
    expect((await clear()).status).toBe(200);
    expect(rows()).toEqual([]);
    expect(await launch("private", { name: "never-save-this" })).toEqual(receipt);
    expect(rows()).toEqual([]);
  });
  it("admits concurrent submissions once, normalizes defaults, and keeps the receipt after completion", async () => {
    const { studio, launch, start, runs, storage } = setup();
    const [first, duplicate] = await Promise.all([
      launch(),
      launch("daily.1", {
        maxConcurrency: 1,
        name: "Ada",
        dryRun: false,
        targets: [],
        stepIds: [],
      }),
    ]);
    expect(first.accepted).toBe(true);
    expect(duplicate).toEqual(first);
    expect(first).toEqual({ accepted: true, launchId: expect.any(String) });
    expect(start).toHaveBeenCalledTimes(1);
    expect(sideEffect).not.toHaveBeenCalled();
    if (!first.accepted) throw new Error("Expected admission");
    expect(await studio.getLaunch(first.launchId)).toEqual({
      launchId: first.launchId,
      commandId: "effect",
      state: "starting",
    });
    await runs.get(first.launchId)!.alarm();
    expect(sideEffect).toHaveBeenCalledTimes(1);
    expect(await studio.getLaunch(first.launchId)).toMatchObject({
      state: "finished",
      runId: expect.any(String),
    });
    expect(await launch()).toEqual(first);
    expect(start).toHaveBeenCalledTimes(1);
    const rows = storage.sql.exec("SELECT * FROM tubeless_launch_admissions").toArray();
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain("Ada");
    expect(await studio.getLaunch("missing")).toBeUndefined();
  });

  it("conflicts on changed command, values, controls, or deployment without consuming a new launch", async () => {
    const { storage, launch, start } = setup();
    const first = await launch();
    expect(first.accepted).toBe(true);
    for (const result of [
      await launch("daily.1", { name: "Grace" }),
      await launch("daily.1", { name: "Ada", maxConcurrency: 2 }),
      await launch("daily.1", { name: "Ada", dryRun: true }),
      await launch("daily.1", { name: "Ada" }, "greeting"),
      await launch("daily.1", { name: "Ada" }, "removed-command"),
      await setup({ storage, maxRunDurationMs: 30_000 }).launch(),
      await setup({ storage, deploymentId: "release-2" }).launch(),
    ])
      expect(result).toMatchObject({
        accepted: false,
        code: "idempotency_conflict",
        launchId: "launchId" in first ? first.launchId : undefined,
      });
    expect(start).toHaveBeenCalledTimes(1);
    expect(storage.sql.exec("SELECT launch_id FROM tubeless_launches").toArray()).toHaveLength(1);
    expect((await launch("daily.2")).accepted).toBe(true);
    expect(start).toHaveBeenCalledTimes(2);
  });

  it("replays after object recreation, history clearing, and an arbitrary passage of time", async () => {
    let now = 1_000;
    const first = setup({ now: () => now });
    const receipt = await first.launch();
    if (!receipt.accepted) throw new Error("Expected admission");
    await first.runs.get(receipt.launchId)!.alarm();
    const clear = await first.studio.fetch(
      new Request("https://studio.example/api/history", {
        method: "DELETE",
        headers: { origin: "https://studio.example", "x-tubeless-studio-clear-history": "1" },
      })
    );
    expect(clear.status).toBe(200);
    expect(await openDurableRunStore(first.storage).listEvents()).toEqual([]);
    now += 10 * 365 * 86_400_000;
    const restarted = setup({ storage: first.storage, now: () => now });
    restarted.storage.setAlarm = () => Promise.reject(new Error("alarm unavailable"));
    expect(await restarted.launch()).toEqual(receipt);
    expect(restarted.start).not.toHaveBeenCalled();
    expect(await restarted.studio.getLaunch(receipt.launchId)).toMatchObject({ state: "finished" });
  });

  it("owns submitted values and key before asynchronous hashing", async () => {
    const { studio, launch, start } = setup();
    const values = { name: "Ada" };
    const options = {
      commandId: "effect",
      values,
      idempotencyKey: "original",
      projectId: "p",
      deploymentId: "release-1",
    };
    const pending = studio.launch(options);
    values.name = "changed";
    options.idempotencyKey = "changed";
    const receipt = await pending;
    expect(start.mock.calls[0]![0].values.name).toBe("Ada");
    expect(await launch("original")).toEqual(receipt);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("executes JSON-normalized numbers, preserves array order, and bounds the normalized intent", async () => {
    const observed = vi.fn();
    const { step } = createSteps<{
      offset: number;
      labels: readonly string[];
      __proto__: string;
    }>();
    const inspect = step("inspect", { run: (_inputs, context) => observed(context.options) });
    const command = definePipelineCommand(definePipeline({ id: "numeric", steps: [inspect] }), {
      params: {
        offset: { type: "number", default: 0 },
        labels: { type: "string", multiple: true },
        ["__proto__"]: { type: "string", default: "own value" },
      },
    });
    const catalog = new Map(
      hostedProjectCommands(defineProject("p", [command])).map((entry) => [
        entry.descriptor.id,
        entry,
      ])
    );
    const { launch, runs, start } = setup({ commands: catalog });
    const receipt = await launch("numbers", { offset: -0, labels: ["a", "b"] }, "numeric");
    if (!receipt.accepted) throw new Error("Expected admission");
    expect(await launch("numbers", { labels: ["a", "b"], offset: 0 }, "numeric")).toEqual(receipt);
    expect(await launch("numbers", { labels: ["b", "a"], offset: 0 }, "numeric")).toMatchObject({
      code: "idempotency_conflict",
    });
    await runs.get(receipt.launchId)!.alarm();
    expect(observed).toHaveBeenCalledWith({
      offset: 0,
      labels: ["a", "b"],
      ["__proto__"]: "own value",
    });
    expect(Object.is(observed.mock.calls[0]![0].offset, -0)).toBe(false);
    expect(
      await launch(
        "oversized",
        { labels: Array.from({ length: 17 }, () => "x".repeat(4096)) },
        "numeric"
      )
    ).toMatchObject({ accepted: false, code: "invalid_launch" });
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid inputs before reserving keys or dispatching", async () => {
    const { launch, studio, storage, start } = setup();
    for (const result of [
      await launch(""),
      await launch("bad key"),
      await launch("x".repeat(201)),
      await launch("unknown", {}, "unknown"),
      await launch("bad-number", { name: "Ada", maxConcurrency: NaN }),
      await launch("bad-control", { name: "Ada", maxConcurrency: 0 }),
      await launch("too-large", { name: "x".repeat(4097) }),
      await studio.launch({
        commandId: "effect",
        values: { name: "Ada" },
        idempotencyKey: "wrong-deployment",
        projectId: "p",
        deploymentId: "other",
      }),
    ])
      expect(result).toMatchObject({ accepted: false, code: "invalid_launch" });
    expect(start).not.toHaveBeenCalled();
    expect(storage.alarmAtMs()).toBeUndefined();
    expect(storage.sql.exec("SELECT * FROM tubeless_launch_admissions").toArray()).toEqual([]);
    expect((await launch("x".repeat(200))).accepted).toBe(true);
  });

  it("does not commit admission when recovery cannot be scheduled", async () => {
    const { storage, launch, start } = setup();
    const setAlarm = storage.setAlarm.bind(storage);
    storage.setAlarm = () => Promise.reject(new Error("alarm unavailable"));
    await expect(launch()).rejects.toThrow("alarm unavailable");
    expect(storage.sql.exec("SELECT * FROM tubeless_launches").toArray()).toEqual([]);
    storage.setAlarm = setAlarm;
    expect((await launch()).accepted).toBe(true);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("preserves a committed admission whose reply was lost before dispatch, then reconciles it", async () => {
    let now = 1_000;
    const original = setup({ now: () => now });
    const transaction = original.storage.transactionSync.bind(original.storage);
    original.storage.transactionSync = (fn) => {
      const result = transaction(fn);
      original.storage.transactionSync = transaction;
      throw new Error(`lost admission reply: ${typeof result}`);
    };
    await expect(original.launch()).rejects.toThrow("lost admission reply");
    expect(original.start).not.toHaveBeenCalled();
    const restarted = setup({ storage: original.storage, now: () => now });
    const receipt = await restarted.launch();
    if (!receipt.accepted) throw new Error("Expected admission replay");
    expect(restarted.start).not.toHaveBeenCalled();
    expect(original.storage.alarmAtMs()).toBe(181_000);
    now = 181_001;
    await restarted.studio.alarm();
    expect(await restarted.studio.getLaunch(receipt.launchId)).toMatchObject({ state: "failed" });
    expect(await restarted.launch()).toEqual(receipt);
    expect(sideEffect).not.toHaveBeenCalled();
  });

  it("never retries an unconfirmed dispatch and fences a pending unadmitted job", async () => {
    const { launch, studio, runs, start } = setup({
      start: async (job, run) => {
        await run.start(job);
        throw new Error("start RPC lost");
      },
    });
    const receipt = await launch();
    if (!receipt.accepted) throw new Error("Expected durable admission");
    expect(await studio.getLaunch(receipt.launchId)).toMatchObject({ state: "failed" });
    await runs.get(receipt.launchId)!.alarm();
    expect(sideEffect).not.toHaveBeenCalled();
    expect(await launch()).toEqual(receipt);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("preserves the outcome when a dispatch reply is lost after execution", async () => {
    const { launch, studio, start } = setup({
      start: async (job, run) => {
        await run.start(job);
        await run.alarm();
        throw new Error("start RPC lost after execution");
      },
    });
    const receipt = await launch();
    if (!receipt.accepted) throw new Error("Expected durable admission");
    expect(await studio.getLaunch(receipt.launchId)).toMatchObject({ state: "finished" });
    expect(await launch()).toEqual(receipt);
    expect(start).toHaveBeenCalledTimes(1);
    expect(sideEffect).toHaveBeenCalledTimes(1);
  });
});
