import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSteps, definePipeline, type StandardSchemaV1 } from "../core/pipeline.js";
import { defineProject } from "../project/project.js";
import { hostedProjectCommands } from "../hosting/hosting-commands.js";
import { createFakeDurableStorage } from "./cloudflare-storage.test-support.js";
import { RunObjectCore, type RunJob } from "./cloudflare-run.js";
import { StudioObjectCore, type RunStubLike } from "./cloudflare-studio.js";

const inputSchema = (minimum: number): StandardSchemaV1<{ name: string }, { name: string }> => ({
  "~standard": {
    vendor: "test",
    version: 1,
    validate: (value) => {
      const name = (value as { name?: unknown }).name;
      return typeof name === "string" && name.length >= minimum
        ? { value: { name } }
        : { issues: [{ message: `Expected at least ${minimum} characters`, path: ["name"] }] };
    },
    jsonSchema: {
      input: () => ({
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      }),
    },
  } as StandardSchemaV1<{ name: string }, { name: string }>["~standard"],
});
const greetSteps = createSteps(inputSchema(3));
const greet = greetSteps.step("greet", { run: (_inputs, context) => `hi ${context.options.name}` });
const Greeting = definePipeline({ id: "greeting", steps: [greet], finalize: greet });
const slowSteps = createSteps(inputSchema(0));
const wait = slowSteps.step("wait", {
  run: (_inputs, context) =>
    new Promise<string>((resolve, reject) => {
      const timer = setTimeout(resolve, 10_000, "done");
      context.signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(context.signal?.reason);
        },
        { once: true }
      );
    }),
});
const Slow = definePipeline({ id: "slow", steps: [wait], finalize: wait });
const commands = new Map(
  hostedProjectCommands(defineProject("p", [Greeting, Slow])).map((entry) => [
    entry.descriptor.id,
    entry,
  ])
);

function setup(
  options: {
    startRuns?: boolean;
    now?: () => number;
    storage?: ReturnType<typeof createFakeDurableStorage>;
    start?: (job: RunJob) => Promise<void>;
  } = {}
) {
  const runs = new Map<string, RunObjectCore>();
  const settled: Promise<void>[] = [];
  let studio!: StudioObjectCore;
  const studioStorage = options.storage ?? createFakeDurableStorage();
  const starts: RunJob[] = [];
  const runStub = (launchId: string): RunStubLike => {
    let core = runs.get(launchId);
    if (!core) {
      core = new RunObjectCore({
        storage: createFakeDurableStorage(),
        commands,
        ingest: () => studio,
      });
      runs.set(launchId, core);
    }
    const run = core;
    return {
      async start(job: RunJob) {
        starts.push(job);
        if (options.start) return options.start(job);
        await run.start(job);
        if (options.startRuns !== false) settled.push(run.alarm());
      },
      cancel: () => run.cancel(),
    };
  };
  studio = new StudioObjectCore({
    storage: studioStorage,
    commands,
    clientScript: "",
    maxRunDurationMs: 60_000,
    runStub,
    startTimeoutMs: 200,
    ...(options.now ? { now: options.now } : {}),
  });
  const api = (path: string, init?: RequestInit) =>
    studio.fetch(new Request(`https://studio.example${path}`, init));
  const launch = (command: string, values: Record<string, unknown>) =>
    api(`/api/commands/${command}/runs`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-tubeless-studio-launch": "1",
        origin: "https://studio.example",
      },
      body: JSON.stringify({ values }),
    });
  return { studio, storage: studioStorage, api, launch, settled, starts };
}

describe("Studio object", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("launches, acknowledges after the start is recorded, and records completion", async () => {
    const { api, launch, settled } = setup();
    const response = await launch("greeting", { name: "ada" });
    expect(response.status).toBe(202);
    const { runId } = (await response.json()) as { runId: string };
    await Promise.all(settled);
    const detail = (await (await api(`/api/runs/${encodeURIComponent(runId)}`)).json()) as {
      run: { status: string };
    };
    expect(detail.run.status).toBe("completed");
    expect(
      ((await (await api("/api/snapshot")).json()) as { liveRunIds: string[] }).liveRunIds
    ).toEqual([]);
  });

  it("rejects unknown commands and invalid values before starting a run", async () => {
    const { launch } = setup();
    expect((await launch("missing", {})).status).toBe(404);
    const rejected = await launch("greeting", {});
    expect(rejected.status).toBe(400);
  });

  it("answers a command that exits before recording a run", async () => {
    const { api, launch, settled } = setup();
    const response = await launch("greeting", { name: "ab" });
    await Promise.all(settled);
    expect([202, 400]).toContain(response.status);
    const body = (await response.json()) as {
      accepted: boolean;
      runId?: string;
      errors?: string[];
    };
    if (body.accepted) {
      const detail = (await (
        await api(`/api/runs/${encodeURIComponent(body.runId ?? "")}`)
      ).json()) as { run: { status: string } };
      expect(detail.run.status).toBe("failed");
    } else {
      expect(body.errors?.join("\n")).toMatch(
        /Expected at least 3 characters|before recording a run/
      );
    }
  });

  it("cancels a live run through its run object", async () => {
    const { api, launch, settled } = setup();
    const { runId } = (await (await launch("slow", { name: "" })).json()) as { runId: string };
    expect(
      ((await (await api("/api/snapshot")).json()) as { liveRunIds: string[] }).liveRunIds
    ).toEqual([runId]);
    const cancel = await api(`/api/runs/${encodeURIComponent(runId)}/cancel`, {
      method: "POST",
      headers: { "x-tubeless-studio-cancel": "1", origin: "https://studio.example" },
    });
    expect(cancel.status).toBe(202);
    await Promise.all(settled);
    const detail = (await (await api(`/api/runs/${encodeURIComponent(runId)}`)).json()) as {
      run: { status: string };
    };
    expect(detail.run.status).toBe("cancelled");
  });

  it("reports an unrecorded start as uncertain, then reconciles it", async () => {
    let now = 1_000;
    const { api, launch, studio, storage } = setup({ startRuns: false, now: () => now });
    const response = await launch("greeting", { name: "ada" });
    expect(response.status).toBe(400);
    expect(JSON.stringify(await response.json())).toMatch(/may still start/);
    now += 60_000 + 120_001;
    await studio.alarm();
    // A second reconcile is a no-op once the launch is failed.
    await studio.alarm();
    expect(storage.alarmAtMs()).toBe(181_000);
    expect(
      ((await (await api("/api/snapshot")).json()) as { liveRunIds: string[] }).liveRunIds
    ).toEqual([]);
  });

  it("answers a rejected start as a failed launch that is not live", async () => {
    const { api, launch } = setup({ start: () => Promise.reject(new Error("boom")) });
    const response = await launch("greeting", { name: "ada" });
    expect(response.status).toBe(400);
    expect(JSON.stringify(await response.json())).toMatch(/could not start/);
    expect(
      ((await (await api("/api/snapshot")).json()) as { liveRunIds: string[] }).liveRunIds
    ).toEqual([]);
  });

  it("does not touch the run object when the reconcile alarm cannot be scheduled", async () => {
    const storage = createFakeDurableStorage();
    storage.setAlarm = () => Promise.reject(new Error("alarm unavailable"));
    const { launch, starts } = setup({ storage });
    const response = await launch("greeting", { name: "ada" });
    expect(response.status).toBe(400);
    expect(JSON.stringify(await response.json())).toMatch(/could not start/);
    expect(starts).toEqual([]);
  });

  it("answers a hung start within the start timeout", async () => {
    const { launch } = setup({ start: () => new Promise<void>(() => {}) });
    const response = await launch("greeting", { name: "ada" });
    expect(response.status).toBe(400);
    expect(JSON.stringify(await response.json())).toMatch(/within 200 ms.*may still start/);
  });

  it("keeps the earliest reconcile alarm across launches", async () => {
    let now = 1_000;
    const { launch, storage } = setup({ startRuns: false, now: () => now });
    await launch("greeting", { name: "ada" });
    expect(storage.alarmAtMs()).toBe(181_000);
    now += 30_000;
    await launch("greeting", { name: "ada" });
    expect(storage.alarmAtMs()).toBe(181_000);
  });

  it("reschedules the reconcile alarm while a fresh launch remains active", async () => {
    let now = 1_000;
    const { launch, studio, storage } = setup({ startRuns: false, now: () => now });
    await launch("greeting", { name: "ada" });
    now += 100_000;
    await launch("greeting", { name: "ada" });
    now += 81_001;
    await studio.alarm();
    expect(storage.alarmAtMs()).toBe(now + 60_000 + 120_000);
  });
});
