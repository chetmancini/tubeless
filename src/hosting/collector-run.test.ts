import { afterEach, describe, expect, it, vi } from "vitest";
import { createSqliteLaunchStoreFixture } from "./launch-store-sqlite.test-support.js";
import { provisionCollectorAttempt } from "./collector-credentials.js";
import { createHostedCollector } from "./collector-http.js";
import { runCollectorJob } from "./collector-run.js";
import { commands, job } from "./run.test-support.js";
import { started } from "./collector.test-support.js";

const cleanup: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0)) close();
});
async function setup() {
  const fixture = createSqliteLaunchStoreFixture();
  cleanup.push(() => fixture.store.close());
  const token = await provisionCollectorAttempt(
    fixture.store,
    {
      launchId: "l1",
      attemptId: "attempt",
      commandId: "greeting",
      pipelineId: "greeting",
      deploymentId: "revision",
      createdAtMs: Date.now(),
    },
    Date.now() + 60_000
  );
  const collector = createHostedCollector({ store: fixture.store });
  const options = {
    job: { ...job({ name: "Ada" }), attemptId: "attempt" },
    baseUrl: "https://collector.test",
    token,
    deploymentId: "revision",
    controller: new AbortController(),
    output: { cwd: "/tmp", stdout: { write: vi.fn() }, stderr: { write: vi.fn() } },
    onClaim: vi.fn(async (_workerId: string) => {}),
    loadCommands: vi.fn(async () => commands),
    fetch: vi.fn<typeof fetch>((input, init) => collector.fetch(new Request(input, init))),
  };
  return { ...fixture, options, collector };
}

describe("collector job admission and supervision boundary", () => {
  it("owns job input across asynchronous admission and uses the shared hosted execution path", async () => {
    const { options, store } = await setup();
    const entry = commands.get("greeting")!;
    const execute = vi.fn(entry.command.execute.bind(entry.command));
    options.loadCommands.mockResolvedValue(
      new Map([["greeting", { ...entry, command: { ...entry.command, execute } }]])
    );
    const pending = runCollectorJob(options);
    options.job.values.name = "changed";
    options.job.commandId = "missing";
    expect(await pending).toEqual({ status: "history-confirmed" });
    expect(options.onClaim).toHaveBeenCalledOnce();
    expect(options.loadCommands).toHaveBeenCalledOnce();
    expect(
      (await store.listEvents()).find((event) => event.name === "pipeline.completed")
    ).toMatchObject({ payload: { status: "completed" } });
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Ada" }),
      expect.anything()
    );
  });

  it("leaves a lost claim unconfirmed without loading application code or reporting termination", async () => {
    const { options, collector, readLaunch } = await setup();
    options.fetch.mockImplementation(async (input, init) => {
      await collector.fetch(new Request(input, init));
      throw new TypeError("lost reply with private details");
    });
    expect(await runCollectorJob(options)).toEqual({ status: "unconfirmed" });
    expect(options.fetch).toHaveBeenCalledOnce();
    expect(options.loadCommands).not.toHaveBeenCalled();
    expect(options.onClaim).not.toHaveBeenCalled();
    expect(readLaunch("l1")?.admitted).toBe(1);
    expect(readLaunch("l1")?.state).toBe("starting");
  });

  it("reports claim refusal without loading user code", async () => {
    const { options } = await setup();
    options.deploymentId = "wrong";
    expect(await runCollectorJob(options)).toEqual({ status: "refused" });
    expect(options.loadCommands).not.toHaveBeenCalled();
    expect(options.onClaim).not.toHaveBeenCalled();
  });

  it("returns setup failure to supervision without prematurely synthesizing terminal history", async () => {
    const { options, readLaunch, store } = await setup();
    options.loadCommands.mockRejectedValue(new Error("secret module details"));
    expect(await runCollectorJob(options)).toEqual({
      status: "history-unconfirmed",
    });
    expect(options.onClaim).toHaveBeenCalledOnce();
    expect(readLaunch("l1")?.state).toBe("starting");
    expect(await store.listEvents()).toEqual([]);
    expect(options.output.stderr.write).not.toHaveBeenCalled();
  });

  it("does not load a module if cancellation arrives while admission is in flight", async () => {
    const { options, collector } = await setup();
    options.fetch.mockImplementation(async (input, init) => {
      const response = await collector.fetch(new Request(input, init));
      options.controller.abort();
      return response;
    });
    expect(await runCollectorJob(options)).toEqual({
      status: "history-unconfirmed",
    });
    expect(options.onClaim).toHaveBeenCalledOnce();
    expect(options.loadCommands).not.toHaveBeenCalled();
  });

  it("refuses invalid execution budgets before admission", async () => {
    const { options } = await setup();
    options.job.maxRunDurationMs = 0;
    await expect(runCollectorJob(options)).rejects.toThrow("budget");
    expect(options.fetch).not.toHaveBeenCalled();
  });

  it("leaves a delivered root start unconfirmed when no terminal event was emitted", async () => {
    const { options, readLaunch, store } = await setup();
    const entry = commands.get("greeting")!;
    options.loadCommands.mockResolvedValue(
      new Map([
        [
          "greeting",
          {
            ...entry,
            command: {
              ...entry.command,
              async execute(_values, context) {
                await context!.pipelineContext!.tracing!.exporter.export({
                  ...started(),
                  pipelineId: "greeting",
                });
              },
            },
          },
        ],
      ])
    );
    expect(await runCollectorJob(options)).toEqual({ status: "history-unconfirmed" });
    expect(readLaunch("l1")?.state).toBe("running");
    expect((await store.listEvents()).map((event) => event.name)).toEqual(["pipeline.started"]);
  });
});
