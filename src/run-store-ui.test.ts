import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { PipelineRunEventStore, StoredPipelineEvent } from "./run-store.js";
import { PIPELINE_RUN_STUDIO_SCRIPT } from "./run-store-ui-page.js";
import { startPipelineRunStudio, type PipelineRunStudioServer } from "./run-store-ui.js";

async function requestWithHost(
  url: string,
  options: {
    body?: string;
    headers?: Record<string, string>;
    host: string;
    method: string;
  }
): Promise<{ status: number; body: unknown }> {
  const parsed = new URL(url);
  return await new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        headers: { host: options.host, ...options.headers },
        hostname: parsed.hostname,
        method: options.method,
        path: parsed.pathname,
        port: parsed.port,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({
            body: text === "" ? undefined : JSON.parse(text),
            status: response.statusCode ?? 0,
          });
        });
      }
    );
    request.on("error", reject);
    if (options.body !== undefined) request.write(options.body);
    request.end();
  });
}

const servers: PipelineRunStudioServer[] = [];
const fixtureParameters = [
  {
    description: "Message to process.",
    flag: "message",
    key: "message",
    multiple: false,
    positional: false,
    required: true,
    type: "string" as const,
  },
];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

function memoryStore(events: readonly StoredPipelineEvent[]): PipelineRunEventStore {
  return {
    close() {},
    export() {},
    async listEvents(query = {}) {
      return events
        .filter(
          (event) =>
            (query.runId === undefined || event.runId === query.runId) &&
            (query.pipelineId === undefined || event.pipelineId === query.pipelineId) &&
            (query.afterId === undefined || event.id > query.afterId)
        )
        .slice(0, query.limit);
    },
  };
}

const events: StoredPipelineEvent[] = [
  {
    attributes: { dry_run: false },
    id: 1,
    name: "pipeline.started",
    pipelineId: "studio-fixture",
    runId: "run-1",
    timestampMs: 10,
    version: 1,
  },
  {
    attributes: { status: "completed" },
    durationMs: 5,
    id: 2,
    name: "pipeline.completed",
    pipelineId: "studio-fixture",
    runId: "run-1",
    timestampMs: 15,
    version: 1,
  },
];

describe("local pipeline run studio", () => {
  it("rejects malformed command parameter metadata before listening", async () => {
    await expect(
      startPipelineRunStudio({
        launcher: {
          commands: [
            {
              canPlan: false,
              id: "invalid",
              name: "Invalid",
              parameters: [{ flag: "value", key: "value", type: "mystery" }] as never,
            },
          ],
          async launch() {
            return { accepted: true, runId: "unused" };
          },
        },
        port: 0,
        store: memoryStore(events),
      })
    ).rejects.toThrow('Studio command "invalid" has invalid parameters.');
  });

  it("rejects ambiguous launcher command definitions before listening", async () => {
    await expect(
      startPipelineRunStudio({
        launcher: {
          commands: [
            {
              canPlan: false,
              id: "duplicate",
              name: "First",
              parameters: fixtureParameters,
            },
            {
              canPlan: false,
              id: "duplicate",
              name: "Second",
              parameters: fixtureParameters,
            },
          ],
          async launch() {
            return { accepted: true, runId: "unused" };
          },
        },
        port: 0,
        store: memoryStore(events),
      })
    ).rejects.toThrow('Duplicate studio command id "duplicate".');
  });

  it("serves the standalone interface and keeps launching disabled by default", async () => {
    const server = await startPipelineRunStudio({ port: 0, store: memoryStore(events) });
    servers.push(server);

    const page = await fetch(server.url);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
    const html = await page.text();
    expect(html).toContain("Tubeless — Local Studio");
    expect(html).toContain("nested work stays with its parent");
    expect(html).toContain("/api/runs/");
    expect(html).toContain("function selectedRunFingerprint");
    expect(html).toContain("fingerprint === state.detailFingerprint && state.detail");
    expect(html).toContain("const requestedRunId = state.selectedRunId");
    expect(html).toContain("if (state.selectedRunId !== requestedRunId) return");
    expect(html).not.toContain('data-view="active"');
    expect(html).not.toContain('data-view="definitions"');
    expect(html).toContain("Run pipeline");
    expect(html).toContain("Available pipelines");
    expect(html).toContain("Preview plan");
    expect(html).toContain("Pipeline inputs");
    expect(html).toContain("Execution controls");
    expect(html).toContain("Built into Tubeless");
    expect(html).toContain("if (!parameter.exclusive || !parameter.multiple) return []");
    expect(html).not.toContain("parameter.group !== 'execution' || !parameter.multiple");
    expect(html).toContain("if (checked !== Boolean(parameter.default))");
    expect(html).toContain("Clear run history?");
    expect(html).toContain("Cancel run");
    expect(html).toContain("x-tubeless-studio-cancel");
    expect(html).toContain("data-cancel-run-id");
    expect(html).toContain("liveRunIds");
    expect(html).toContain("step-status-icon");
    expect(html).toContain("status-mark");
    expect(html).toContain("progress-details");
    expect(html).toContain("step.nestedPipeline");
    expect(html).toContain("step.remote");
    expect(html).toContain("Remote step");
    expect(html).toContain("declared steps");
    expect(html).toContain("Showing ");
    expect(html).not.toContain("mode-tabs");
    expect(html).not.toContain("Pipes");

    const snapshot = await fetch(`${server.url}/api/snapshot`).then((response) => response.json());
    expect(snapshot).toMatchObject({
      activeRunCount: 0,
      completedRunCount: 1,
      liveRunIds: [],
      runs: [{ pipelineId: "studio-fixture", status: "completed" }],
    });
    const run = await fetch(`${server.url}/api/runs/run-1`).then((response) => response.json());
    expect(run).toMatchObject({ run: { runId: "run-1", status: "completed" } });

    await expect(
      fetch(`${server.url}/api/commands`).then((response) => response.json())
    ).resolves.toEqual({ commands: [] });
    await expect(
      fetch(`${server.url}/api/capabilities`).then((response) => response.json())
    ).resolves.toEqual({ canCancel: false, canClearHistory: false });
    const clear = await fetch(`${server.url}/api/history`, {
      headers: { "x-tubeless-studio-clear-history": "1" },
      method: "DELETE",
    });
    expect(clear.status).toBe(405);
    const mutation = await fetch(`${server.url}/api/commands/fixture/runs`, {
      body: JSON.stringify({ values: {} }),
      headers: { "content-type": "application/json", "x-tubeless-studio-launch": "1" },
      method: "POST",
    });
    expect(mutation.status).toBe(405);
    const cancel = await fetch(`${server.url}/api/runs/run-1/cancel`, {
      headers: { "x-tubeless-studio-cancel": "1" },
      method: "POST",
    });
    expect(cancel.status).toBe(405);
  });

  it("pins the studio page CSP hashes to the exact inline script and style", async () => {
    const server = await startPipelineRunStudio({ port: 0, store: memoryStore(events) });
    servers.push(server);

    const page = await fetch(server.url);
    const csp = page.headers.get("content-security-policy") ?? "";
    const html = await page.text();
    const script = /<script>([\s\S]*)<\/script>/.exec(html)?.[1];
    const style = /<style>([\s\S]*)<\/style>/.exec(html)?.[1];
    expect(script).toBeTruthy();
    expect(style).toBeTruthy();
    const scriptHash = `'sha256-${createHash("sha256").update(script!).digest("base64")}'`;
    const styleHash = `'sha256-${createHash("sha256").update(style!).digest("base64")}'`;
    expect(html).toContain(`<script>${PIPELINE_RUN_STUDIO_SCRIPT}</script>`);
    expect(csp).toBe(
      `default-src 'none'; style-src ${styleHash}; script-src ${scriptHash}; img-src data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
    );
    expect(csp).not.toContain("unsafe-inline");
  });

  it("exposes only injected commands and delegates bounded structured launch values", async () => {
    const launches: { commandId: string; values: Record<string, unknown> }[] = [];
    const plans: { commandId: string; dryRun?: boolean; targets?: readonly string[] }[] = [];
    const server = await startPipelineRunStudio({
      launcher: {
        commands: [
          {
            canPlan: true,
            description: "Run the fixture.",
            id: "fixture",
            name: "Fixture",
            parameters: fixtureParameters,
          },
        ],
        plan(commandId, input) {
          plans.push({ commandId, dryRun: input.dryRun, targets: input.targets });
          return {
            dryRun: input.dryRun === true,
            errors: [],
            ok: true,
            pipelineId: "fixture",
            steps: [],
          };
        },
        async launch(commandId, values) {
          launches.push({ commandId, values });
          return { accepted: true, runId: "studio-run-1" };
        },
      },
      port: 0,
      store: memoryStore(events),
    });
    servers.push(server);

    await expect(
      fetch(`${server.url}/api/commands`).then((response) => response.json())
    ).resolves.toEqual({
      commands: [
        {
          canPlan: true,
          description: "Run the fixture.",
          id: "fixture",
          name: "Fixture",
          parameters: fixtureParameters,
        },
      ],
    });
    const planResponse = await fetch(`${server.url}/api/commands/fixture/plan`, {
      body: JSON.stringify({ dryRun: true, targets: ["publish"] }),
      headers: { "content-type": "application/json", "x-tubeless-studio-plan": "1" },
      method: "POST",
    });
    expect(planResponse.status).toBe(200);
    await expect(planResponse.json()).resolves.toMatchObject({
      plan: { dryRun: true, ok: true, pipelineId: "fixture" },
    });
    expect(plans).toEqual([{ commandId: "fixture", dryRun: true, targets: ["publish"] }]);
    const response = await fetch(`${server.url}/api/commands/fixture/runs`, {
      body: JSON.stringify({
        values: { dryRun: false, message: "hello world", retries: [1, 2], tags: ["one", "two"] },
      }),
      headers: { "content-type": "application/json", "x-tubeless-studio-launch": "1" },
      method: "POST",
    });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ accepted: true, runId: "studio-run-1" });
    expect(launches).toEqual([
      {
        commandId: "fixture",
        values: { dryRun: false, message: "hello world", retries: [1, 2], tags: ["one", "two"] },
      },
    ]);

    const crossOriginShape = await fetch(`${server.url}/api/commands/fixture/runs`, {
      body: JSON.stringify({ values: {} }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(crossOriginShape.status).toBe(415);

    const missingPlanHeader = await fetch(`${server.url}/api/commands/fixture/plan`, {
      body: JSON.stringify({ dryRun: true }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(missingPlanHeader.status).toBe(415);
    const missingLaunchType = await fetch(`${server.url}/api/commands/fixture/runs`, {
      body: JSON.stringify({ values: { message: "hello" } }),
      headers: { "x-tubeless-studio-launch": "1" },
      method: "POST",
    });
    expect(missingLaunchType.status).toBe(415);
    const forgedHost = await requestWithHost(`${server.url}/api/commands/fixture/runs`, {
      body: JSON.stringify({ values: { message: "hello" } }),
      headers: { "content-type": "application/json", "x-tubeless-studio-launch": "1" },
      host: `evil.example:${new URL(server.url).port}`,
      method: "POST",
    });
    expect(forgedHost.status).toBe(403);
    expect(forgedHost.body).toEqual({ error: "The request host is not trusted." });
    expect(launches).toHaveLength(1);
    await expect(
      fetch(`${server.url}/api/capabilities`).then((response) => response.json())
    ).resolves.toEqual({ canCancel: false, canClearHistory: false });
    const cancelWithoutCapability = await fetch(`${server.url}/api/runs/studio-run-1/cancel`, {
      headers: { "x-tubeless-studio-cancel": "1" },
      method: "POST",
    });
    expect(cancelWithoutCapability.status).toBe(405);
  });

  it("does not advertise cancel when liveRunIds is missing", async () => {
    const server = await startPipelineRunStudio({
      launcher: {
        commands: [
          {
            canPlan: false,
            id: "fixture",
            name: "Fixture",
            parameters: fixtureParameters,
          },
        ],
        async launch() {
          return { accepted: true, runId: "live-run" };
        },
        async cancel(runId) {
          return { cancelled: true, runId };
        },
      },
      port: 0,
      store: memoryStore(events),
    });
    servers.push(server);

    await expect(
      fetch(`${server.url}/api/capabilities`).then((response) => response.json())
    ).resolves.toEqual({ canCancel: false, canClearHistory: false });
    await expect(
      fetch(`${server.url}/api/snapshot`).then((response) => response.json())
    ).resolves.toMatchObject({ liveRunIds: [] });
  });

  it("cancels a live launch only through an injected launcher cancel", async () => {
    const cancelled: string[] = [];
    const server = await startPipelineRunStudio({
      launcher: {
        commands: [
          {
            canPlan: false,
            id: "fixture",
            name: "Fixture",
            parameters: fixtureParameters,
          },
        ],
        async launch() {
          return { accepted: true, runId: "live-run" };
        },
        async cancel(runId) {
          cancelled.push(runId);
          return runId === "live-run" ? { cancelled: true, runId } : { cancelled: false };
        },
        liveRunIds() {
          return ["live-run"];
        },
      },
      port: 0,
      store: memoryStore(events),
    });
    servers.push(server);

    await expect(
      fetch(`${server.url}/api/capabilities`).then((response) => response.json())
    ).resolves.toEqual({ canCancel: true, canClearHistory: false });
    await expect(
      fetch(`${server.url}/api/snapshot`).then((response) => response.json())
    ).resolves.toMatchObject({ liveRunIds: ["live-run"] });
    const missingHeader = await fetch(`${server.url}/api/runs/live-run/cancel`, { method: "POST" });
    expect(missingHeader.status).toBe(415);
    const forgedHost = await requestWithHost(`${server.url}/api/runs/live-run/cancel`, {
      headers: { "x-tubeless-studio-cancel": "1" },
      host: `evil.example:${new URL(server.url).port}`,
      method: "POST",
    });
    expect(forgedHost.status).toBe(403);
    expect(forgedHost.body).toEqual({ error: "The request host is not trusted." });
    const unknown = await fetch(`${server.url}/api/runs/missing-run/cancel`, {
      headers: { "x-tubeless-studio-cancel": "1" },
      method: "POST",
    });
    expect(unknown.status).toBe(404);
    await expect(unknown.json()).resolves.toEqual({ error: "The run is not a live launch." });
    const response = await fetch(`${server.url}/api/runs/live-run/cancel`, {
      headers: { "x-tubeless-studio-cancel": "1" },
      method: "POST",
    });
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ cancelled: true, runId: "live-run" });
    expect(cancelled).toEqual(["missing-run", "live-run"]);
  });

  it("pages beyond a store query cap and incrementally loads newer events", async () => {
    const stored = [...events];
    const cursors: (number | undefined)[] = [];
    const store: PipelineRunEventStore = {
      close() {},
      export() {},
      async listEvents(query = {}) {
        cursors.push(query.afterId);
        return stored.filter((event) => event.id > (query.afterId ?? 0)).slice(0, 1);
      },
    };
    const server = await startPipelineRunStudio({ port: 0, store });
    servers.push(server);

    await expect(
      fetch(`${server.url}/api/snapshot`).then((response) => response.json())
    ).resolves.toMatchObject({
      completedRunCount: 1,
      lastEventId: 2,
      runs: [{ runId: "run-1", status: "completed" }],
    });
    expect(cursors).toEqual([undefined, 1, 2]);

    stored.push(
      {
        attributes: { dry_run: false },
        id: 3,
        name: "pipeline.started",
        pipelineId: "studio-fixture",
        runId: "run-2",
        timestampMs: 20,
        version: 1,
      },
      {
        attributes: { status: "completed" },
        durationMs: 5,
        id: 4,
        name: "pipeline.completed",
        pipelineId: "studio-fixture",
        runId: "run-2",
        timestampMs: 25,
        version: 1,
      }
    );
    await expect(
      fetch(`${server.url}/api/snapshot`).then((response) => response.json())
    ).resolves.toMatchObject({ completedRunCount: 2, lastEventId: 4 });
    expect(cursors.slice(-3)).toEqual([2, 3, 4]);
  });

  it("reads one run from the store and omits snapshot log bodies", async () => {
    const queries: { afterId?: number; runId?: string }[] = [];
    const stored: StoredPipelineEvent[] = [
      {
        attributes: { dry_run: false },
        id: 1,
        name: "pipeline.started",
        pipelineId: "studio-fixture",
        runId: "run-1",
        timestampMs: 10,
        version: 1,
      },
      {
        attributes: { level: "log", message: "loaded rows" },
        id: 2,
        name: "pipeline.log",
        pipelineId: "studio-fixture",
        runId: "run-1",
        stepId: "load",
        timestampMs: 12,
        version: 1,
      },
      {
        attributes: { status: "completed" },
        durationMs: 5,
        id: 3,
        name: "pipeline.completed",
        pipelineId: "studio-fixture",
        runId: "run-1",
        timestampMs: 15,
        version: 1,
      },
      {
        attributes: { dry_run: false },
        id: 4,
        name: "pipeline.started",
        pipelineId: "other",
        runId: "run-2",
        timestampMs: 20,
        version: 1,
      },
      {
        attributes: { level: "warn", message: "other run only" },
        id: 5,
        name: "pipeline.log",
        pipelineId: "other",
        runId: "run-2",
        timestampMs: 21,
        version: 1,
      },
    ];
    const store: PipelineRunEventStore = {
      close() {},
      export() {},
      async listEvents(query = {}) {
        queries.push({ afterId: query.afterId, runId: query.runId });
        return stored
          .filter(
            (event) =>
              (query.runId === undefined || event.runId === query.runId) &&
              (query.afterId === undefined || event.id > query.afterId)
          )
          .slice(0, query.limit);
      },
    };
    const server = await startPipelineRunStudio({ port: 0, store });
    servers.push(server);

    const snapshot = await fetch(`${server.url}/api/snapshot`).then((response) => response.json());
    expect(JSON.stringify(snapshot)).not.toContain("loaded rows");
    expect(JSON.stringify(snapshot)).not.toContain("other run only");
    expect(snapshot.runs).toEqual([
      expect.objectContaining({
        eventCount: 2,
        logCount: 1,
        logs: [],
        runId: "run-2",
        status: "running",
      }),
      expect.objectContaining({
        eventCount: 3,
        logCount: 1,
        logs: [],
        runId: "run-1",
        status: "completed",
      }),
    ]);

    queries.length = 0;
    const detail = await fetch(`${server.url}/api/runs/run-1`).then((response) => response.json());
    expect(detail.events.map((event: { id: number }) => event.id)).toEqual([1, 2, 3]);
    expect(detail.run).toMatchObject({
      logCount: 1,
      logs: [{ message: "loaded rows" }],
      runId: "run-1",
      status: "completed",
    });
    expect(queries.length).toBeGreaterThan(0);
    expect(queries.every((query) => query.runId === "run-1")).toBe(true);

    const missing = await fetch(`${server.url}/api/runs/missing`);
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toEqual({ error: "Run not found." });
  });

  it("includes a first store event whose id is zero in snapshots", async () => {
    const store = memoryStore([
      {
        attributes: { dry_run: false },
        id: 0,
        name: "pipeline.started",
        pipelineId: "studio-fixture",
        runId: "run-zero",
        timestampMs: 1,
        version: 1,
      },
    ]);
    const server = await startPipelineRunStudio({ port: 0, store });
    servers.push(server);

    await expect(
      fetch(`${server.url}/api/snapshot`).then((response) => response.json())
    ).resolves.toMatchObject({
      activeRunCount: 1,
      lastEventId: 0,
      runs: [{ runId: "run-zero", status: "running", startedAtMs: 1 }],
    });
  });

  it("clears complete history only through an injected maintenance capability", async () => {
    let stored = [...events];
    let clearCount = 0;
    const store: PipelineRunEventStore = {
      close() {},
      export() {},
      async listEvents(query = {}) {
        return stored.filter((event) => event.id > (query.afterId ?? 0));
      },
    };
    const server = await startPipelineRunStudio({
      history: {
        clear() {
          clearCount += 1;
          stored = [];
        },
      },
      port: 0,
      store,
    });
    servers.push(server);

    await expect(
      fetch(`${server.url}/api/capabilities`).then((response) => response.json())
    ).resolves.toEqual({ canCancel: false, canClearHistory: true });
    const missingHeader = await fetch(`${server.url}/api/history`, { method: "DELETE" });
    expect(missingHeader.status).toBe(415);
    const forgedHost = await requestWithHost(`${server.url}/api/history`, {
      headers: { "x-tubeless-studio-clear-history": "1" },
      host: `evil.example:${new URL(server.url).port}`,
      method: "DELETE",
    });
    expect(forgedHost.status).toBe(403);
    expect(forgedHost.body).toEqual({ error: "The request host is not trusted." });
    expect(clearCount).toBe(0);
    const response = await fetch(`${server.url}/api/history`, {
      headers: { "x-tubeless-studio-clear-history": "1" },
      method: "DELETE",
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      cleared: true,
      eventCount: 2,
      runCount: 1,
    });
    expect(clearCount).toBe(1);
    await expect(
      fetch(`${server.url}/api/snapshot`).then((snapshot) => snapshot.json())
    ).resolves.toMatchObject({ lastEventId: 0, runs: [] });
  });

  it("clears a persisted run left active by an interrupted process", async () => {
    let clearCount = 0;
    const server = await startPipelineRunStudio({
      history: {
        clear() {
          clearCount += 1;
        },
      },
      port: 0,
      store: memoryStore(events.slice(0, 1)),
    });
    servers.push(server);

    const response = await fetch(`${server.url}/api/history`, {
      headers: { "x-tubeless-studio-clear-history": "1" },
      method: "DELETE",
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      cleared: true,
      runCount: 1,
    });
    expect(clearCount).toBe(1);
  });

  it("refuses to clear while the maintenance host knows a writer is live", async () => {
    let clearCount = 0;
    const server = await startPipelineRunStudio({
      history: {
        clear() {
          clearCount += 1;
        },
        isBusy: () => true,
      },
      port: 0,
      store: memoryStore(events),
    });
    servers.push(server);

    const response = await fetch(`${server.url}/api/history`, {
      headers: { "x-tubeless-studio-clear-history": "1" },
      method: "DELETE",
    });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "Wait for active runs to finish before clearing history.",
    });
    expect(clearCount).toBe(0);
  });

  it("brackets an IPv6 host in URLs and trusted request authorities", async () => {
    let clearCount = 0;
    const server = await startPipelineRunStudio({
      history: {
        clear() {
          clearCount += 1;
        },
      },
      host: "::1",
      port: 0,
      store: memoryStore(events),
    });
    servers.push(server);

    expect(server.url).toMatch(/^http:\/\/\[::1\]:\d+$/);
    const response = await fetch(`${server.url}/api/history`, {
      headers: { "x-tubeless-studio-clear-history": "1" },
      method: "DELETE",
    });
    expect(response.status).toBe(200);
    expect(clearCount).toBe(1);
  });

  it("rejects a snapshot read whose Host does not match the bound authority", async () => {
    const server = await startPipelineRunStudio({ port: 0, store: memoryStore(events) });
    servers.push(server);

    const forgedHost = await requestWithHost(`${server.url}/api/snapshot`, {
      host: `evil.example:${new URL(server.url).port}`,
      method: "GET",
    });
    expect(forgedHost.status).toBe(403);
    expect(forgedHost.body).toEqual({ error: "The request host is not trusted." });
  });

  it("rejects the studio page when Host does not match the bound authority", async () => {
    const server = await startPipelineRunStudio({ port: 0, store: memoryStore(events) });
    servers.push(server);

    const forgedHost = await requestWithHost(server.url, {
      host: `evil.example:${new URL(server.url).port}`,
      method: "GET",
    });
    expect(forgedHost.status).toBe(403);
    expect(forgedHost.body).toEqual({ error: "The request host is not trusted." });
  });

  it("rejects a run read whose Host does not match the bound authority", async () => {
    const server = await startPipelineRunStudio({ port: 0, store: memoryStore(events) });
    servers.push(server);

    const forgedHost = await requestWithHost(`${server.url}/api/runs/some-id`, {
      host: `evil.example:${new URL(server.url).port}`,
      method: "GET",
    });
    expect(forgedHost.status).toBe(403);
    expect(forgedHost.body).toEqual({ error: "The request host is not trusted." });
  });

  it("rejects a literal-IP Host that does not match a specific bind", async () => {
    const server = await startPipelineRunStudio({ port: 0, store: memoryStore(events) });
    servers.push(server);

    const port = new URL(server.url).port;
    const forgedHost = await requestWithHost(`${server.url}/api/snapshot`, {
      host: `192.0.2.10:${port}`,
      method: "GET",
    });
    expect(forgedHost.status).toBe(403);
    expect(forgedHost.body).toEqual({ error: "The request host is not trusted." });
  });

  it("accepts localhost and literal-IP Hosts on a wildcard bind", async () => {
    const server = await startPipelineRunStudio({
      host: "0.0.0.0",
      port: 0,
      store: memoryStore(events),
    });
    servers.push(server);

    const port = new URL(server.url).port;
    const snapshotUrl = `http://127.0.0.1:${port}/api/snapshot`;
    for (const host of [
      `127.0.0.1:${port}`,
      `192.0.2.10:${port}`,
      `localhost:${port}`,
      `[::1]:${port}`,
    ]) {
      const response = await requestWithHost(snapshotUrl, { host, method: "GET" });
      expect({ host, status: response.status }).toEqual({ host, status: 200 });
    }

    const forgedHost = await requestWithHost(snapshotUrl, {
      host: `evil.example:${port}`,
      method: "GET",
    });
    expect(forgedHost.status).toBe(403);
    expect(forgedHost.body).toEqual({ error: "The request host is not trusted." });
  });
});
