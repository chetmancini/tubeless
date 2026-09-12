import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TUBELESS_WORKBENCH_EXIT_CODE, runWorkbenchCli, type WorkbenchCliIo } from "./workbench.js";

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
    stderr: { write: (chunk) => void errors.push(chunk) },
    stdout: { write: (chunk) => void output.push(chunk) },
  };
}

async function writeProjectFixture(): Promise<{
  directory: string;
  manifest: string;
  workDirectory: string;
}> {
  const directory = await mkdtemp(path.join(tmpdir(), "tubeless-project-"));
  directories.push(directory);
  const configDirectory = path.join(directory, "config");
  const workDirectory = path.join(configDirectory, "work");
  await mkdir(workDirectory, { recursive: true });
  const cliModuleUrl = pathToFileURL(path.resolve("dist/cli/cli.js")).href;
  const pipelineModuleUrl = pathToFileURL(path.resolve("dist/core/pipeline.js")).href;
  const projectModuleUrl = pathToFileURL(path.resolve("dist/workbench/workbench-project.js")).href;
  await writeFile(
    path.join(directory, "pipeline.mjs"),
    `
      import { definePipelineCommand } from ${JSON.stringify(cliModuleUrl)};
      import { createSteps, definePipeline, requireOutputs } from ${JSON.stringify(pipelineModuleUrl)};
      const step = createSteps();
      const work = step("work", {
        run: (_inputs, context) => {
          context.log.log(\`cwd:\${context.cwd}\`);
          return context.options.message;
        },
      });
      export const FixtureCommand = definePipelineCommand(
        definePipeline({
          id: "project-fixture",
          steps: [work],
          targets: [work],
          finalize: requireOutputs([work], ({ work }) => work),
        }),
        {
          params: { message: { type: "string" } },
          reporter: false,
          summarize: (result) => [\`completed:\${result}\`],
        }
      );
    `
  );
  const manifest = path.join(configDirectory, "project.mjs");
  const manifestSource = `
    import { definePipelineProject } from ${JSON.stringify(projectModuleUrl)};
    export default definePipelineProject({
      cwd: "./work",
      commands: [{
        id: "import-data",
        file: "../pipeline.mjs",
        export: "FixtureCommand",
        name: "Import data",
      }],
    });
  `;
  await writeFile(manifest, manifestSource);
  await writeFile(
    path.join(directory, "tubeless.project.ts"),
    `
      import { definePipelineProject } from ${JSON.stringify(projectModuleUrl)};
      export default definePipelineProject({
        cwd: "./config/work",
        commands: [{
          id: "import-data",
          file: "./pipeline.mjs",
          export: "FixtureCommand",
          name: "Import data",
        }],
      });
    `
  );
  return { directory, manifest, workDirectory };
}

describe("project manifest workbench", () => {
  it("lists registrations without scanning or loading command modules", async () => {
    const { directory } = await writeProjectFixture();
    await rm(path.join(directory, "pipeline.mjs"));
    const io = captureIo(directory);

    const exitCode = await runWorkbenchCli(["list", "--json"], io);

    expect(exitCode).toBe(TUBELESS_WORKBENCH_EXIT_CODE.success);
    expect(JSON.parse(io.output.join(""))).toMatchObject({
      commands: [
        {
          export: "FixtureCommand",
          file: "./pipeline.mjs",
          id: "import-data",
          name: "Import data",
        },
      ],
      cwd: "./config/work",
      version: 1,
    });
    expect(io.errors).toEqual([]);
  });

  it("inspects, plans, graphs, and runs an explicit registered identity", async () => {
    const { directory, manifest, workDirectory } = await writeProjectFixture();
    const projectArgs = ["--project", manifest, "import-data"];

    const inspectIo = captureIo(directory);
    expect(await runWorkbenchCli(["inspect", ...projectArgs, "--json"], inspectIo)).toBe(
      TUBELESS_WORKBENCH_EXIT_CODE.success
    );
    expect(JSON.parse(inspectIo.output.join(""))).toMatchObject({
      commandId: "import-data",
      pipelineId: "project-fixture",
      stepIds: ["work"],
    });

    const planIo = captureIo(directory);
    expect(await runWorkbenchCli(["plan", ...projectArgs, "--target", "work"], planIo)).toBe(
      TUBELESS_WORKBENCH_EXIT_CODE.success
    );
    expect(planIo.output.join(" ")).toContain("work");

    const graphIo = captureIo(directory);
    expect(await runWorkbenchCli(["graph", ...projectArgs], graphIo)).toBe(
      TUBELESS_WORKBENCH_EXIT_CODE.success
    );
    expect(graphIo.output.join(" ")).toContain("flowchart TD");

    const runIo = captureIo(directory);
    expect(
      await runWorkbenchCli(
        [
          "run",
          "--project",
          manifest,
          "--trace",
          "run.ndjson",
          "import-data",
          "--",
          "--message",
          "hello",
        ],
        runIo
      )
    ).toBe(TUBELESS_WORKBENCH_EXIT_CODE.success);
    expect(runIo.output.join(" ")).toContain(`cwd:${workDirectory}`);
    expect(runIo.output.join(" ")).toContain("completed:hello");
    await expect(readFile(path.join(directory, "run.ndjson"), "utf8")).resolves.toContain(
      '"name":"pipeline.completed"'
    );
  });

  it("rejects --export combined with --project on inspect, plan, graph, and run", async () => {
    const { directory, manifest } = await writeProjectFixture();
    const mutexArgs = ["--export", "FixtureCommand", "--project", manifest, "import-data"] as const;

    for (const command of ["inspect", "plan", "graph", "run"] as const) {
      const io = captureIo(directory);
      expect(await runWorkbenchCli([command, ...mutexArgs], io)).toBe(
        TUBELESS_WORKBENCH_EXIT_CODE.usage
      );
      expect(io.errors.join("")).toContain(
        "--export cannot be combined with --project; the manifest owns export selection."
      );
      expect(io.errors.join("")).toContain(`Usage: tubeless ${command}`);
    }
  });

  it("uses a bare id from the current directory default manifest", async () => {
    const { directory } = await writeProjectFixture();
    const io = captureIo(directory);

    expect(await runWorkbenchCli(["inspect", "import-data", "--json"], io)).toBe(
      TUBELESS_WORKBENCH_EXIT_CODE.success
    );
    expect(JSON.parse(io.output.join(""))).toMatchObject({ commandId: "import-data" });
  });

  it("keeps an existing file argument ahead of default-manifest identity lookup", async () => {
    const { directory } = await writeProjectFixture();
    const io = captureIo(directory);

    expect(await runWorkbenchCli(["inspect", "pipeline.mjs", "--json"], io)).toBe(
      TUBELESS_WORKBENCH_EXIT_CODE.success
    );
    expect(JSON.parse(io.output.join(""))).toMatchObject({ pipelineId: "project-fixture" });
    expect(JSON.parse(io.output.join(""))).not.toHaveProperty("commandId");
  });

  it("rejects module aliases that resolve to the same registration", async () => {
    const { directory } = await writeProjectFixture();
    const projectModuleUrl = pathToFileURL(
      path.resolve("dist/workbench/workbench-project.js")
    ).href;
    const manifest = path.join(directory, "config", "duplicate.mjs");
    await writeFile(
      manifest,
      `
        import { definePipelineProject } from ${JSON.stringify(projectModuleUrl)};
        export default definePipelineProject({ commands: [
          { id: "first", file: "../pipeline.mjs", export: "FixtureCommand" },
          { id: "second", file: ".././pipeline.mjs", export: "FixtureCommand" },
        ] });
      `
    );
    const io = captureIo(directory);

    expect(await runWorkbenchCli(["list", "--project", manifest], io)).toBe(
      TUBELESS_WORKBENCH_EXIT_CODE.load
    );
    expect(io.errors.join(" ")).toContain("resolves to a duplicate module registration");
  });

  it("publishes project ids to the studio while legacy catalogs keep their file identity", async () => {
    const { directory, manifest } = await writeProjectFixture();
    const controller = new AbortController();
    const io = { ...captureIo(directory), signal: controller.signal };
    const running = runWorkbenchCli(
      ["ui", "--store", path.join(directory, "runs.sqlite"), "--port", "0", manifest],
      io
    );

    await vi.waitFor(() => expect(io.output.join(" ")).toContain("Tubeless local studio: http://"));
    const url = /Tubeless local studio: (http:\/\/[^\n]+)/.exec(io.output.join(""))?.[1];
    expect(url).toBeDefined();
    await expect(fetch(`${url}/api/commands`).then((response) => response.json())).resolves.toEqual(
      {
        commands: [expect.objectContaining({ id: "import-data", name: "Import data" })],
      }
    );

    controller.abort();
    await expect(running).resolves.toBe(TUBELESS_WORKBENCH_EXIT_CODE.success);
  });
});
