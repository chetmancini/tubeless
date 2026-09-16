import { mkdtemp, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { projectPipelineRun } from "../run-store/run-store.js";
import { openSqlitePipelineRunStore } from "../run-store/run-store-sqlite.js";
import { TUBELESS_WORKBENCH_EXIT_CODE, runWorkbenchCli } from "./workbench.js";
import {
  captureIo,
  writeActualPipelineCommandModule,
  writeGatedPipelineCommandModule,
  writeModule,
  writeStudioConfig,
} from "./workbench.test-support.js";

describe("workbench UI integration", () => {
  it("serves and cleanly stops the optional local studio command", async () => {
    const { directory } = await writeModule("export {};");
    const controller = new AbortController();
    const io = { ...captureIo(directory), signal: controller.signal };
    const command = runWorkbenchCli(
      ["ui", "--store", path.join(directory, "runs.sqlite"), "--port", "0"],
      io
    );

    await vi.waitFor(() => expect(io.output.join("")).toContain("Tubeless local studio: http://"));
    const url = /Tubeless local studio: (http:\/\/[^\n]+)/.exec(io.output.join(""))?.[1];
    expect(url).toBeDefined();
    await expect(fetch(url!)).resolves.toMatchObject({ status: 200 });
    await expect(
      fetch(`${url}/api/capabilities`).then((response) => response.json())
    ).resolves.toEqual({ canCancel: false, canClearHistory: true });
    const cleared = await fetch(`${url}/api/history`, {
      headers: { "x-tubeless-studio-clear-history": "1" },
      method: "DELETE",
    });
    expect(cleared.status).toBe(200);
    await expect(cleared.json()).resolves.toMatchObject({ cleared: true, eventCount: 0 });

    controller.abort();
    await expect(command).resolves.toBe(TUBELESS_WORKBENCH_EXIT_CODE.success);
  });

  it("loads and launches explicitly registered commands from a project manifest", async () => {
    const { directory } = await writeActualPipelineCommandModule();
    await writeStudioConfig(directory);
    const controller = new AbortController();
    const io = { ...captureIo(directory), signal: controller.signal };
    const command = runWorkbenchCli(
      [
        "ui",
        "--store",
        path.join(directory, "runs.sqlite"),
        "--port",
        "0",
        "config/tubeless.project.mjs",
      ],
      io
    );

    await vi.waitFor(() => expect(io.output.join("")).toContain("Tubeless local studio: http://"));
    const url = /Tubeless local studio: (http:\/\/[^\n]+)/.exec(io.output.join(""))?.[1];
    expect(url).toBeDefined();
    const commands = (await fetch(`${url}/api/commands`).then((response) => response.json())) as {
      commands: { id: string; name: string; parameters: { flag: string; type: string }[] }[];
    };
    expect(commands).toEqual({
      commands: [
        expect.objectContaining({
          id: "fixture",
          name: "Studio fixture",
        }),
      ],
    });
    const commandId = commands.commands[0]?.id;
    expect(commandId).toBeDefined();
    expect(commands.commands[0]?.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ flag: "dry-run", type: "boolean" }),
        expect.objectContaining({ flag: "message", type: "string" }),
        expect.objectContaining({ flag: "mode", type: "string" }),
        expect.objectContaining({ flag: "target", type: "string" }),
      ])
    );

    const planResponse = await fetch(`${url}/api/commands/${encodeURIComponent(commandId!)}/plan`, {
      body: JSON.stringify({ dryRun: true, targets: ["work"] }),
      headers: { "content-type": "application/json", "x-tubeless-studio-plan": "1" },
      method: "POST",
    });
    expect(planResponse.status).toBe(200);
    await expect(planResponse.json()).resolves.toMatchObject({
      plan: {
        dryRun: true,
        ok: true,
        pipelineId: "command-fixture",
        steps: [expect.objectContaining({ id: "work", selected: true })],
      },
    });
    await expect(
      fetch(`${url}/api/snapshot`).then((response) => response.json())
    ).resolves.toMatchObject({ runs: [] });

    const invalid = await fetch(`${url}/api/commands/${encodeURIComponent(commandId!)}/runs`, {
      body: JSON.stringify({ values: {} }),
      headers: { "content-type": "application/json", "x-tubeless-studio-launch": "1" },
      method: "POST",
    });
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toMatchObject({
      accepted: false,
      errors: [expect.stringContaining("Missing required option --message")],
    });

    const launched = await fetch(`${url}/api/commands/${encodeURIComponent(commandId!)}/runs`, {
      body: JSON.stringify({ values: { message: "from-studio", targets: ["work"] } }),
      headers: { "content-type": "application/json", "x-tubeless-studio-launch": "1" },
      method: "POST",
    });
    expect(launched.status).toBe(202);
    const launch = (await launched.json()) as { runId: string };
    expect(launch.runId).toContain("command-fixture");
    const recorded = (await fetch(`${url}/api/snapshot`).then((response) => response.json())) as {
      runs: { runId: string }[];
    };
    expect(recorded.runs).toContainEqual(expect.objectContaining({ runId: launch.runId }));
    await vi.waitFor(async () => {
      const snapshot = (await fetch(`${url}/api/snapshot`).then((response) => response.json())) as {
        runs: { runId: string; status: string }[];
      };
      expect(snapshot.runs).toContainEqual(
        expect.objectContaining({ runId: launch.runId, status: "completed" })
      );
    });

    controller.abort();
    await expect(command).resolves.toBe(TUBELESS_WORKBENCH_EXIT_CODE.success);
  });

  it("holds the launch POST until mapOptions records a store row", async () => {
    const gateDirectory = await mkdtemp(path.join(os.tmpdir(), "tubeless-gate-"));
    const gateFile = path.join(gateDirectory, "gate");
    const { directory } = await writeGatedPipelineCommandModule({
      mapOptionsSource: `async (values) => {
        const gateFile = ${JSON.stringify(gateFile)};
        while (!existsSync(gateFile)) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        return values;
      }`,
    });
    await writeStudioConfig(directory, { exportName: "GatedCommand", name: "Gated fixture" });
    const controller = new AbortController();
    const io = { ...captureIo(directory), signal: controller.signal };
    const command = runWorkbenchCli(
      [
        "ui",
        "--store",
        path.join(directory, "runs.sqlite"),
        "--port",
        "0",
        "config/tubeless.project.mjs",
      ],
      io
    );

    await vi.waitFor(() => expect(io.output.join("")).toContain("Tubeless local studio: http://"));
    const url = /Tubeless local studio: (http:\/\/[^\n]+)/.exec(io.output.join(""))?.[1];
    expect(url).toBeDefined();
    const commands = (await fetch(`${url}/api/commands`).then((response) => response.json())) as {
      commands: { id: string }[];
    };
    const commandId = commands.commands[0]?.id;
    expect(commandId).toBeDefined();

    let resolved = false;
    const launchPromise = fetch(`${url}/api/commands/${encodeURIComponent(commandId!)}/runs`, {
      body: JSON.stringify({ values: { message: "x" } }),
      headers: { "content-type": "application/json", "x-tubeless-studio-launch": "1" },
      method: "POST",
    }).then((response) => {
      resolved = true;
      return response;
    });
    await vi.waitFor(async () => {
      const snapshot = (await fetch(`${url}/api/snapshot`).then((response) => response.json())) as {
        liveRunIds: string[];
      };
      expect(snapshot.liveRunIds.length).toBeGreaterThan(0);
    });
    expect(resolved).toBe(false);
    await writeFile(gateFile, "go");
    const launched = await launchPromise;
    expect(launched.status).toBe(202);
    const launch = (await launched.json()) as { runId: string };
    const snapshot = (await fetch(`${url}/api/snapshot`).then((response) => response.json())) as {
      runs: { runId: string }[];
    };
    expect(snapshot.runs).toContainEqual(expect.objectContaining({ runId: launch.runId }));

    controller.abort();
    await expect(command).resolves.toBe(TUBELESS_WORKBENCH_EXIT_CODE.success);
  });

  it("rejects a launch when mapOptions throws before recording a run", async () => {
    const { directory } = await writeGatedPipelineCommandModule({
      mapOptionsSource: `async () => {
        throw new Error("map exploded");
      }`,
    });
    await writeStudioConfig(directory, { exportName: "GatedCommand", name: "Gated fixture" });
    const controller = new AbortController();
    const io = { ...captureIo(directory), signal: controller.signal };
    const command = runWorkbenchCli(
      [
        "ui",
        "--store",
        path.join(directory, "runs.sqlite"),
        "--port",
        "0",
        "config/tubeless.project.mjs",
      ],
      io
    );

    await vi.waitFor(() => expect(io.output.join("")).toContain("Tubeless local studio: http://"));
    const url = /Tubeless local studio: (http:\/\/[^\n]+)/.exec(io.output.join(""))?.[1];
    expect(url).toBeDefined();
    const commands = (await fetch(`${url}/api/commands`).then((response) => response.json())) as {
      commands: { id: string }[];
    };
    const commandId = commands.commands[0]?.id;
    expect(commandId).toBeDefined();

    const failed = await fetch(`${url}/api/commands/${encodeURIComponent(commandId!)}/runs`, {
      body: JSON.stringify({ values: { message: "x" } }),
      headers: { "content-type": "application/json", "x-tubeless-studio-launch": "1" },
      method: "POST",
    });
    expect(failed.status).toBe(400);
    await expect(failed.json()).resolves.toEqual({
      accepted: false,
      code: "launch_rejected",
      errors: [
        `Pipeline command exited (${TUBELESS_WORKBENCH_EXIT_CODE.execution}) before recording a run.`,
      ],
      hint: "Review errors and retry only after resolving the reported cause.",
      message: "Pipeline launch was rejected.",
    });
    await expect(
      fetch(`${url}/api/snapshot`).then((response) => response.json())
    ).resolves.toMatchObject({ runs: [] });

    controller.abort();
    await expect(command).resolves.toBe(TUBELESS_WORKBENCH_EXIT_CODE.success);
  });

  it("rejects a pending launch when the studio shuts down", async () => {
    const gateDirectory = await mkdtemp(path.join(os.tmpdir(), "tubeless-gate-"));
    const gateFile = path.join(gateDirectory, "gate");
    const { directory } = await writeGatedPipelineCommandModule({
      mapOptionsSource: `async (values, context) => {
        const gateFile = ${JSON.stringify(gateFile)};
        while (!existsSync(gateFile)) {
          if (context.signal?.aborted) throw context.signal.reason;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        return values;
      }`,
    });
    await writeStudioConfig(directory, { exportName: "GatedCommand", name: "Gated fixture" });
    const controller = new AbortController();
    const io = { ...captureIo(directory), signal: controller.signal };
    const command = runWorkbenchCli(
      [
        "ui",
        "--store",
        path.join(directory, "runs.sqlite"),
        "--port",
        "0",
        "config/tubeless.project.mjs",
      ],
      io
    );

    await vi.waitFor(() => expect(io.output.join("")).toContain("Tubeless local studio: http://"));
    const url = /Tubeless local studio: (http:\/\/[^\n]+)/.exec(io.output.join(""))?.[1];
    expect(url).toBeDefined();
    const commands = (await fetch(`${url}/api/commands`).then((response) => response.json())) as {
      commands: { id: string }[];
    };
    const commandId = commands.commands[0]?.id;
    expect(commandId).toBeDefined();

    let resolved = false;
    const launchPromise = fetch(`${url}/api/commands/${encodeURIComponent(commandId!)}/runs`, {
      body: JSON.stringify({ values: { message: "x" } }),
      headers: { "content-type": "application/json", "x-tubeless-studio-launch": "1" },
      method: "POST",
    }).then((response) => {
      resolved = true;
      return response;
    });
    await vi.waitFor(async () => {
      const snapshot = (await fetch(`${url}/api/snapshot`).then((response) => response.json())) as {
        liveRunIds: string[];
      };
      expect(snapshot.liveRunIds.length).toBeGreaterThan(0);
    });
    expect(resolved).toBe(false);
    controller.abort();
    const failed = await launchPromise;
    expect(failed.status).toBe(400);
    await expect(failed.json()).resolves.toEqual({
      accepted: false,
      code: "launch_rejected",
      errors: ["The local studio is stopping."],
      hint: "Review errors and retry only after resolving the reported cause.",
      message: "Pipeline launch was rejected.",
    });
    await expect(command).resolves.toBe(TUBELESS_WORKBENCH_EXIT_CODE.success);
  });

  it("cancels one live studio launch without aborting a sibling", async () => {
    const { directory } = await writeActualPipelineCommandModule();
    await writeStudioConfig(directory);
    const controller = new AbortController();
    const io = { ...captureIo(directory), signal: controller.signal };
    const command = runWorkbenchCli(
      [
        "ui",
        "--store",
        path.join(directory, "runs.sqlite"),
        "--port",
        "0",
        "config/tubeless.project.mjs",
      ],
      io
    );

    await vi.waitFor(() => expect(io.output.join("")).toContain("Tubeless local studio: http://"));
    const url = /Tubeless local studio: (http:\/\/[^\n]+)/.exec(io.output.join(""))?.[1];
    expect(url).toBeDefined();
    await expect(
      fetch(`${url}/api/capabilities`).then((response) => response.json())
    ).resolves.toEqual({ canCancel: true, canClearHistory: true });
    const commands = (await fetch(`${url}/api/commands`).then((response) => response.json())) as {
      commands: { id: string }[];
    };
    const commandId = commands.commands[0]?.id;
    expect(commandId).toBeDefined();

    const launchWait = async (message: string) => {
      const launched = await fetch(`${url}/api/commands/${encodeURIComponent(commandId!)}/runs`, {
        body: JSON.stringify({ values: { message, mode: "wait" } }),
        headers: { "content-type": "application/json", "x-tubeless-studio-launch": "1" },
        method: "POST",
      });
      expect(launched.status).toBe(202);
      return (await launched.json()) as { runId: string };
    };
    const first = await launchWait("first");
    const second = await launchWait("second");
    await vi.waitFor(async () => {
      const snapshot = (await fetch(`${url}/api/snapshot`).then((response) => response.json())) as {
        liveRunIds: string[];
        runs: { runId: string; status: string }[];
      };
      expect(snapshot.runs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ runId: first.runId, status: "running" }),
          expect.objectContaining({ runId: second.runId, status: "running" }),
        ])
      );
      expect(snapshot.liveRunIds).toEqual(expect.arrayContaining([first.runId, second.runId]));
      expect(snapshot.liveRunIds).toHaveLength(2);
    });

    const cancelled = await fetch(`${url}/api/runs/${encodeURIComponent(first.runId)}/cancel`, {
      headers: { "x-tubeless-studio-cancel": "1" },
      method: "POST",
    });
    expect(cancelled.status).toBe(202);
    await expect(cancelled.json()).resolves.toEqual({ cancelled: true, runId: first.runId });
    await vi.waitFor(async () => {
      const snapshot = (await fetch(`${url}/api/snapshot`).then((response) => response.json())) as {
        liveRunIds: string[];
        runs: { error?: { message: string }; runId: string; status: string }[];
      };
      expect(snapshot.runs).toContainEqual(
        expect.objectContaining({
          runId: first.runId,
          status: "cancelled",
          error: expect.objectContaining({ message: expect.stringContaining("run was cancelled") }),
        })
      );
      expect(snapshot.runs).toContainEqual(
        expect.objectContaining({ runId: second.runId, status: "running" })
      );
      expect(snapshot.liveRunIds).toEqual([second.runId]);
    });
    const stale = await fetch(`${url}/api/runs/${encodeURIComponent(first.runId)}/cancel`, {
      headers: { "x-tubeless-studio-cancel": "1" },
      method: "POST",
    });
    expect(stale.status).toBe(404);

    controller.abort();
    await expect(command).resolves.toBe(TUBELESS_WORKBENCH_EXIT_CODE.success);
    const store = await openSqlitePipelineRunStore(path.join(directory, "runs.sqlite"));
    try {
      const sibling = projectPipelineRun(await store.listEvents({ runId: second.runId }));
      expect(sibling).toMatchObject({
        runId: second.runId,
        status: "cancelled",
        error: { message: expect.stringContaining("local studio is stopping") },
      });
    } finally {
      await store.close();
    }
  });

  it("rejects browser-triggered execution on a non-loopback host", async () => {
    const { directory } = await writeActualPipelineCommandModule();
    const commandIo = captureIo(directory);
    await expect(
      runWorkbenchCli(
        ["ui", "--host", "0.0.0.0", "--command", "pipeline.mjs", "--port", "0"],
        commandIo
      )
    ).resolves.toBe(TUBELESS_WORKBENCH_EXIT_CODE.usage);
    expect(commandIo.errors.join("")).toContain(
      "Browser-triggered execution requires a loopback --host."
    );

    await writeStudioConfig(directory);
    const catalogIo = captureIo(directory);
    await expect(
      runWorkbenchCli(
        ["ui", "--host", "0.0.0.0", "--port", "0", "config/tubeless.project.mjs"],
        catalogIo
      )
    ).resolves.toBe(TUBELESS_WORKBENCH_EXIT_CODE.usage);
    expect(catalogIo.errors.join("")).toContain(
      "Browser-triggered execution requires a loopback --host."
    );
  });

  it("keeps a non-loopback studio read-only and history-immutable", async () => {
    const { directory } = await writeModule("export {};");
    const controller = new AbortController();
    const io = { ...captureIo(directory), signal: controller.signal };
    const command = runWorkbenchCli(
      ["ui", "--host", "0.0.0.0", "--store", path.join(directory, "runs.sqlite"), "--port", "0"],
      io
    );

    await vi.waitFor(() => expect(io.output.join("")).toContain("Tubeless local studio: http://"));
    const url = /Tubeless local studio: (http:\/\/[^\n]+)/.exec(io.output.join(""))?.[1];
    expect(url).toMatch(/^http:\/\/0\.0\.0\.0:\d+$/);
    await expect(
      fetch(`${url}/api/capabilities`).then((response) => response.json())
    ).resolves.toEqual({ canCancel: false, canClearHistory: false });
    await expect(
      fetch(`${url}/api/history`, {
        headers: { "x-tubeless-studio-clear-history": "1" },
        method: "DELETE",
      }).then((response) => response.status)
    ).resolves.toBe(405);
    await expect(
      fetch(`${url}/api/commands/fixture/runs`, {
        body: JSON.stringify({ values: {} }),
        headers: { "content-type": "application/json", "x-tubeless-studio-launch": "1" },
        method: "POST",
      }).then((response) => response.status)
    ).resolves.toBe(405);

    controller.abort();
    await expect(command).resolves.toBe(TUBELESS_WORKBENCH_EXIT_CODE.success);
  });
});
