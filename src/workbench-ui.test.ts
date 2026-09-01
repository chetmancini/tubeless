import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TUBELESS_WORKBENCH_EXIT_CODE, type WorkbenchCliIo } from "./workbench-shared.js";
import { runUi } from "./workbench-ui.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true }))
  );
});

function captureIo(cwd: string): WorkbenchCliIo & { errors: string[]; output: string[] } {
  const errors: string[] = [];
  const output: string[] = [];
  return {
    cwd,
    errors,
    output,
    stderr: {
      write: (chunk) => {
        errors.push(chunk);
      },
    },
    stdout: {
      write: (chunk) => {
        output.push(chunk);
      },
    },
  };
}

async function tempDir(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "tubeless-ui-"));
  directories.push(directory);
  return directory;
}

async function writeCommandFixture(): Promise<{ directory: string; filePath: string }> {
  const directory = await tempDir();
  const filePath = path.join(directory, "pipeline.mjs");
  const cliModuleUrl = pathToFileURL(path.resolve("dist/cli.js")).href;
  const pipelineModuleUrl = pathToFileURL(path.resolve("dist/pipeline.js")).href;
  await writeFile(
    filePath,
    `
      import { definePipelineCommand } from ${JSON.stringify(cliModuleUrl)};
      import { createSteps, definePipeline, requireOutputs } from ${JSON.stringify(pipelineModuleUrl)};
      const step = createSteps();
      const work = step("work", {
        run: (_inputs, context) => context.options.message,
      });
      export const FixtureCommand = definePipelineCommand(
        definePipeline({
          id: "command-fixture",
          steps: [work],
          targets: [work],
          finalize: requireOutputs([work], ({ work }) => work),
        }),
        {
          params: {
            message: { type: "string", description: "Message to process." },
          },
          reporter: false,
        }
      );
    `
  );
  return { directory, filePath };
}

async function writeStudioConfig(directory: string): Promise<string> {
  const studioModuleUrl = pathToFileURL(path.resolve("dist/workbench-studio.js")).href;
  const configDirectory = path.join(directory, "config");
  await mkdir(configDirectory);
  const filePath = path.join(configDirectory, "tubeless.studio.mjs");
  await writeFile(
    filePath,
    `
      import { definePipelineStudio } from ${JSON.stringify(studioModuleUrl)};
      export default definePipelineStudio({
        cwd: "..",
        commands: [{
          file: "../pipeline.mjs",
          export: "FixtureCommand",
          name: "Studio fixture",
        }],
      });
    `
  );
  return filePath;
}

function studioUrl(output: string): string {
  const url = /Tubeless local studio: (http:\/\/[^\n]+)/.exec(output)?.[1];
  expect(url).toBeDefined();
  return url!;
}

describe("runUi", () => {
  it("prints help and exits 0", async () => {
    const io = captureIo(await tempDir());

    const exitCode = await runUi(["--help"], io);

    expect(exitCode).toBe(TUBELESS_WORKBENCH_EXIT_CODE.success);
    expect(io.output.join("")).toContain("Usage: tubeless ui [options] [studio-file]");
    expect(io.output.join("")).toContain("--command <path>");
    expect(io.output.join("")).toContain("--port <number>");
    expect(io.errors).toEqual([]);
  });

  it("rejects a non-integer or out-of-range --port", async () => {
    const directory = await tempDir();
    for (const argv of [["--port", "abc"], ["--port=-1"], ["--port", "65536"]]) {
      const io = captureIo(directory);
      const exitCode = await runUi(argv, io);
      expect(exitCode).toBe(TUBELESS_WORKBENCH_EXIT_CODE.usage);
      expect(io.errors.join("")).toContain("Error: --port must be an integer from 0 to 65535.");
    }
  });

  it("rejects conflicting registration flags", async () => {
    const directory = await tempDir();
    const exportOnly = captureIo(directory);
    expect(await runUi(["--export", "FixtureCommand"], exportOnly)).toBe(
      TUBELESS_WORKBENCH_EXIT_CODE.usage
    );
    expect(exportOnly.errors.join("")).toContain(
      "Error: --export requires exactly one registered --command."
    );

    const exportWithStudio = captureIo(directory);
    expect(
      await runUi(
        ["--export", "FixtureCommand", "--command", "pipeline.mjs", "studio.mjs"],
        exportWithStudio
      )
    ).toBe(TUBELESS_WORKBENCH_EXIT_CODE.usage);
    expect(exportWithStudio.errors.join("")).toContain(
      "Error: --export requires exactly one registered --command."
    );

    const twoStudios = captureIo(directory);
    expect(await runUi(["first.mjs", "second.mjs"], twoStudios)).toBe(
      TUBELESS_WORKBENCH_EXIT_CODE.usage
    );
    expect(twoStudios.errors.join("")).toContain("Error: Pass at most one studio config file.");

    const duplicate = captureIo(directory);
    expect(await runUi(["--command", "pipeline.mjs", "--command", "pipeline.mjs"], duplicate)).toBe(
      TUBELESS_WORKBENCH_EXIT_CODE.usage
    );
    expect(duplicate.errors.join("")).toContain("is duplicated.");

    const nonLoopback = captureIo(directory);
    expect(await runUi(["--host", "0.0.0.0", "--command", "pipeline.mjs"], nonLoopback)).toBe(
      TUBELESS_WORKBENCH_EXIT_CODE.usage
    );
    expect(nonLoopback.errors.join("")).toContain(
      "Error: Browser-triggered execution requires a loopback --host."
    );
  });

  it("registers studio commands and clears launch bookkeeping after the run settles", async () => {
    const { directory, filePath } = await writeCommandFixture();
    await writeStudioConfig(directory);
    const controller = new AbortController();
    const io = { ...captureIo(directory), signal: controller.signal };
    const pending = runUi(
      ["--store", path.join(directory, "runs.sqlite"), "--port", "0", "config/tubeless.studio.mjs"],
      io
    );

    await vi.waitFor(() => expect(io.output.join("")).toContain("Tubeless local studio: http://"));
    const url = studioUrl(io.output.join(""));
    const payload = (await fetch(`${url}/api/commands`).then((response) => response.json())) as {
      commands: {
        canPlan: boolean;
        id: string;
        name: string;
        parameters: { flag: string; type: string }[];
      }[];
    };

    expect(payload).toEqual({
      commands: [
        expect.objectContaining({
          canPlan: true,
          id: `${filePath}#FixtureCommand`,
          name: "Studio fixture",
        }),
      ],
    });
    expect(payload.commands[0]?.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ flag: "message", type: "string" }),
        expect.objectContaining({ flag: "target", type: "string" }),
      ])
    );

    const commandId = payload.commands[0]?.id;
    expect(commandId).toBeDefined();
    const launched = await fetch(`${url}/api/commands/${encodeURIComponent(commandId!)}/runs`, {
      body: JSON.stringify({ values: { message: "from-studio" } }),
      headers: { "content-type": "application/json", "x-tubeless-studio-launch": "1" },
      method: "POST",
    });
    expect(launched.status).toBe(202);
    const launch = (await launched.json()) as { runId: string };
    await vi.waitFor(async () => {
      const snapshot = (await fetch(`${url}/api/snapshot`).then((response) => response.json())) as {
        liveRunIds: string[];
        runs: { runId: string; status: string }[];
      };
      expect(snapshot.runs).toContainEqual(
        expect.objectContaining({ runId: launch.runId, status: "completed" })
      );
      expect(snapshot.liveRunIds).toEqual([]);
    });

    controller.abort();
    await expect(pending).resolves.toBe(TUBELESS_WORKBENCH_EXIT_CODE.success);
  });
});
