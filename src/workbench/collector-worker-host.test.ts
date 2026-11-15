import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSteps, definePipeline } from "../../dist/core/pipeline.js";
import { definePipelineCommand } from "../../dist/cli/cli.js";
import { createCollectorWorkerHost } from "../../dist/workbench/collector-worker-host.js";
import { studioDescriptor } from "../hosting/hosting-commands.js";
import { workerFixture } from "./collector-worker.test-support.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups.length = 0;
  vi.restoreAllMocks();
});
const request = (path: string, body?: unknown) =>
  new Request(`https://studio.test${path}`, {
    headers: {
      "x-test-admin": "admin",
      "content-type": "application/json",
      origin: "https://studio.test",
      "x-tubeless-studio-launch": "1",
      "x-tubeless-studio-cancel": "1",
    },
    ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
  });
async function setup(mode = "nested") {
  const fixture = await workerFixture();
  cleanups.push(() => fixture.close());
  await fixture.writeModule(mode);
  const { step } = createSteps();
  const parentEffect = vi.fn();
  const work = step("work", { run: parentEffect });
  const command = definePipelineCommand(
    definePipeline({ id: "parent", steps: [work], finalize: work }),
    { params: {} }
  );
  const entry = { command, descriptor: studioDescriptor(command), module: fixture.module };
  const createHost = async (
    overrides: Partial<Parameters<typeof createCollectorWorkerHost>[0]> = {}
  ) => {
    const host = await createCollectorWorkerHost({
      store: fixture.state.fixture.store,
      commands: new Map([["parent", entry]]),
      deploymentId: "revision-1",
      collectorUrl: fixture.baseUrl,
      clientScript: "",
      maxRunDurationMs: 20_000,
      authenticate: (request) =>
        request.headers.get("x-test-admin") === "admin"
          ? undefined
          : new Response(null, { status: 401 }),
      worker: {
        cwd: fixture.directory,
        env: fixture.workerOptions.env,
        fetch: fixture.workerOptions.fetch,
      },
      ...overrides,
    });
    fixture.state.collector = host.collector;
    cleanups.push(() => host.close());
    return host;
  };
  return { ...fixture, entry, parentEffect, createHost };
}

describe("Studio launches supervised collector workers", { timeout: 15_000 }, () => {
  it("acknowledges persisted nested history over HTTPS and preserves it after reopen", async () => {
    const fixture = await setup();
    const host = await fixture.createHost();
    const response = await host.studio.fetch(request("/api/commands/parent/runs", { values: {} }));
    expect(response.status).toBe(202);
    const result = await response.json();
    expect(result).toEqual({ accepted: true, runId: expect.any(String) });
    expect(JSON.stringify(result)).not.toMatch(/[a-f0-9]{32}\.[a-f0-9]{64}/);
    expect(
      (await fixture.state.fixture.store.listEvents()).some(
        (event) => event.runId === result.runId && event.name === "pipeline.started"
      )
    ).toBe(true);
    await host.drain();
    expect(fixture.parentEffect).not.toHaveBeenCalled();
    expect(Number((await readFile(fixture.effectFile, "utf8")).trim())).not.toBe(process.pid);
    const history = await fixture.state.fixture.store.listEvents();
    expect(history.filter((event) => event.name === "pipeline.completed")).toHaveLength(2);
    await host.close();
    fixture.restartCollector();
    const reopened = await fixture.createHost();
    const detail = await (await reopened.studio.fetch(request(`/api/runs/${result.runId}`))).json();
    expect(detail.run).toMatchObject({ runId: result.runId, status: "completed" });
    expect(await fixture.state.fixture.store.listEvents()).toEqual(history);
    expect(
      (await (await reopened.studio.fetch(request("/api/snapshot"))).json()).liveRunIds
    ).toEqual([]);
  });

  it("advertises a live owned root and persists browser cancellation until history drains", async () => {
    const { createHost, state } = await setup("wait");
    const host = await createHost();
    const { runId } = await (
      await host.studio.fetch(request("/api/commands/parent/runs", { values: {} }))
    ).json();
    expect((await (await host.studio.fetch(request("/api/snapshot"))).json()).liveRunIds).toEqual([
      runId,
    ]);
    expect(await state.fixture.store.liveRunIds()).toEqual([]);
    expect((await host.studio.fetch(request(`/api/runs/${runId}/cancel`, {}))).status).toBe(202);
    expect(
      state.fixture.storage.sql.exec("SELECT * FROM tubeless_attempt_cancellations").toArray()
    ).toHaveLength(1);
    await host.drain();
    const completions = (await state.fixture.store.listEvents()).filter(
      (event) => event.name === "pipeline.completed"
    );
    expect(completions).toHaveLength(2);
    expect(completions.every((event) => event.payload.status === "cancelled")).toBe(true);
    expect((await host.studio.fetch(request(`/api/runs/${runId}/cancel`, {}))).status).toBe(404);
  });

  it("keeps browser/admin authority separate from worker credentials and validates before provisioning", async () => {
    const { createHost, token, state, importFile } = await setup();
    const host = await createHost();
    expect(
      (
        await host.studio.fetch(
          new Request("https://studio.test/api/commands", {
            headers: { authorization: `Bearer ${token}` },
          })
        )
      ).status
    ).toBe(401);
    expect((await host.collector.fetch(request("/api/commands"))).status).toBe(404);
    expect(
      (await host.collector.fetch(request("/v1/launches/launch/control", { attemptId: "attempt" })))
        .status
    ).toBe(401);
    expect(
      (await host.studio.fetch(request("/v1/launches/launch/control", { attemptId: "attempt" })))
        .status
    ).toBe(405);
    for (const [command, values, status] of [
      ["missing", {}, 404],
      ["parent", { unexpected: "input" }, 400],
    ] as const)
      expect(
        (await host.studio.fetch(request(`/api/commands/${command}/runs`, { values }))).status
      ).toBe(status);
    expect(
      state.fixture.storage.sql.exec("SELECT * FROM tubeless_attempts").toArray()
    ).toHaveLength(1);
    await expect(readFile(importFile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("acknowledges exact-byte batch replay after the commit reply was lost", async () => {
    const { createHost, state } = await setup();
    const accept = state.fixture.store.acceptCollectorBatch.bind(state.fixture.store);
    vi.spyOn(state.fixture.store, "acceptCollectorBatch").mockImplementationOnce(
      async (...args) => {
        await accept(...args);
        throw new Error("Committed but reply lost");
      }
    );
    const host = await createHost();
    expect(
      (await host.studio.fetch(request("/api/commands/parent/runs", { values: {} }))).status
    ).toBe(202);
    await host.drain();
    const bodies = state.requests
      .filter((request) => request.operation === "batches")
      .map((request) => request.body);
    expect(bodies[0]).toEqual(bodies[1]);
    expect(
      (await state.fixture.store.listEvents()).filter((event) => event.name === "pipeline.started")
    ).toHaveLength(2);
  });

  it("settles a failed module load from the supervisor's committed pre-root failure", async () => {
    const fixture = await setup();
    const host = await fixture.createHost({
      commands: new Map([
        ["parent", { ...fixture.entry, module: new URL("missing.mjs", fixture.module) }],
      ]),
    });
    const response = await host.studio.fetch(request("/api/commands/parent/runs", { values: {} }));
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain("missing.mjs");
    await host.drain();
    expect(await fixture.state.fixture.store.listEvents()).toEqual([]);
    expect(
      fixture.state.requests.filter((request) => request.operation === "failure")
    ).toHaveLength(1);
  });

  it("times out an uncertain claim without retrying execution or exposing credentials", async () => {
    const { createHost, state, importFile } = await setup();
    state.dropClaim = true;
    const host = await createHost({ startTimeoutMs: 300 });
    const response = await host.studio.fetch(request("/api/commands/parent/runs", { values: {} }));
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("may still start");
    await host.drain();
    expect(state.requests.filter((request) => request.operation === "admit")).toHaveLength(1);
    expect(await state.fixture.store.listEvents()).toEqual([]);
    await expect(readFile(importFile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("closes admission, cancels active processes and drains before the caller closes storage", async () => {
    const { createHost, state } = await setup("wait");
    const host = await createHost();
    expect(
      (await host.studio.fetch(request("/api/commands/parent/runs", { values: {} }))).status
    ).toBe(202);
    await host.close();
    const before = state.fixture.storage.sql
      .exec("SELECT * FROM tubeless_attempts")
      .toArray().length;
    expect(
      (await host.studio.fetch(request("/api/commands/parent/runs", { values: {} }))).status
    ).toBe(400);
    expect(
      state.fixture.storage.sql.exec("SELECT * FROM tubeless_attempts").toArray()
    ).toHaveLength(before);
    expect(
      (await state.fixture.store.listEvents()).filter(
        (event) => event.name === "pipeline.completed"
      )
    ).toHaveLength(2);
  });
});
