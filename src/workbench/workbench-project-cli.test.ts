import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TUBELESS_WORKBENCH_EXIT_CODE, runWorkbenchCli, type WorkbenchCliIo } from "./workbench.js";
import { loadPipelineProjectFile } from "./workbench-project-loader.js";

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
  const projectModuleUrl = pathToFileURL(path.resolve("dist/project/project.js")).href;
  const pipelineModuleUrl = pathToFileURL(path.resolve("dist/core/pipeline.js")).href;
  await writeFile(
    path.join(directory, "pipeline.mjs"),
    `
      import { definePipelineCommand } from ${JSON.stringify(cliModuleUrl)};
      import { createSteps, definePipeline, requireOutputs } from ${JSON.stringify(pipelineModuleUrl)};
      const { step } = createSteps();
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
    import { defineCommandCatalog } from ${JSON.stringify(cliModuleUrl)};
    import { defineProject } from ${JSON.stringify(projectModuleUrl)};
    export const UnrelatedProject = defineProject("unrelated", []);
    export default defineCommandCatalog({
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
      import { defineCommandCatalog } from ${JSON.stringify(cliModuleUrl)};
      import { defineProject } from ${JSON.stringify(projectModuleUrl)};
      export const UnrelatedProject = defineProject("unrelated", []);
      export default defineCommandCatalog({
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

async function writeAutomaticProjectFixture(): Promise<{
  directory: string;
  projectFile: string;
}> {
  const directory = await mkdtemp(path.join(tmpdir(), "tubeless-automatic-project-"));
  directories.push(directory);
  const pipelineModuleUrl = pathToFileURL(path.resolve("dist/core/pipeline.js")).href;
  const projectModuleUrl = pathToFileURL(path.resolve("dist/project/project.js")).href;
  const cliModuleUrl = pathToFileURL(path.resolve("dist/cli/cli.js")).href;
  const projectFile = path.join(directory, "tubeless.project.ts");
  await writeFile(
    projectFile,
    `
      import { createSteps, definePipeline } from ${JSON.stringify(pipelineModuleUrl)};
      import { defineProject } from ${JSON.stringify(projectModuleUrl)};
      import { defineCommandCatalog } from ${JSON.stringify(cliModuleUrl)};
      export const UnrelatedCatalog = defineCommandCatalog({
        commands: [{ id: "unrelated", file: "./missing-command.ts" }],
      });
      const optionsSchema = {
        "~standard": {
          version: 1,
          vendor: "fixture",
          validate: (value) => ({ value }),
          jsonSchema: { input: () => ({
            type: "object",
            properties: { message: { type: "string", description: "Message to print." } },
            required: ["message"],
          }) },
        },
      };
      const { step } = createSteps(optionsSchema);
      const work = step("work", {
        run: (_inputs, context) => {
          context.log.log(\`worked:\${context.options.message}\`);
          return context.options.message;
        },
      });
      const pipeline = definePipeline({ id: "automatic", steps: [work] });
      export default defineProject("fixture-project", [pipeline], {
        name: "Fixture jobs",
        description: "Print a message.",
      });
    `
  );
  return { directory, projectFile };
}

describe("project file workbench", () => {
  it.each([
    ["export { project, project as alias };", "project"],
    ["export { catalog, catalog as alias };", "catalog"],
    ["export { project as default, otherProject, catalog };", "project"],
    ["export { catalog as default, otherCatalog, project };", "catalog"],
    ["export { project, catalog };", "multiple"],
    ["export { project, otherProject };", "multiple"],
    ["export { catalog, otherCatalog };", "multiple"],
    ["export { project, catalog }; export default null;", 'Export "default"'],
    ["export { project, catalog }; export default undefined;", 'Export "default"'],
  ])("selects project-file roots for %s", async (exports, expected) => {
    const directory = await mkdtemp(path.join(tmpdir(), "tubeless-root-selection-"));
    directories.push(directory);
    const projectModuleUrl = pathToFileURL(path.resolve("dist/project/project.js")).href;
    const cliModuleUrl = pathToFileURL(path.resolve("dist/cli/cli.js")).href;
    const filePath = path.join(directory, "roots.mjs");
    await writeFile(
      filePath,
      `
        import { defineProject } from ${JSON.stringify(projectModuleUrl)};
        import { defineCommandCatalog } from ${JSON.stringify(cliModuleUrl)};
        const project = defineProject("selected", []);
        const otherProject = defineProject("other", []);
        const catalog = defineCommandCatalog({ commands: [{ id: "selected", file: "./selected.ts" }] });
        const otherCatalog = defineCommandCatalog({ commands: [{ id: "other", file: "./other.ts" }] });
        ${exports}
      `
    );
    const io = captureIo(directory);
    const loaded = await loadPipelineProjectFile(filePath, io);
    if (expected === "project" || expected === "catalog") {
      expect(loaded).toMatchObject(
        expected === "project"
          ? { inventory: { id: "selected" } }
          : { inventory: { commands: [{ id: "selected" }] } }
      );
      expect(io.errors).toEqual([]);
    } else {
      expect(loaded).toEqual({ exitCode: TUBELESS_WORKBENCH_EXIT_CODE.load });
      expect(io.errors.join("")).toContain(expected);
      expect(io.errors.join("")).not.toContain("--export");
    }
  });

  it.each(["run", "ui"])(
    "rejects type-only project inputs before %s can execute them",
    async (command) => {
      const directory = await mkdtemp(path.join(tmpdir(), "tubeless-type-only-project-"));
      directories.push(directory);
      const pipelineModuleUrl = pathToFileURL(path.resolve("dist/core/pipeline.js")).href;
      const projectModuleUrl = pathToFileURL(path.resolve("dist/project/project.js")).href;
      const projectFile = path.join(directory, "tubeless.project.ts");
      await writeFile(
        projectFile,
        `
          import { createSteps, definePipeline } from ${JSON.stringify(pipelineModuleUrl)};
          import { defineProject } from ${JSON.stringify(projectModuleUrl)};
          type RequiredOptions = { message: string };
          const { step } = createSteps<RequiredOptions>();
          const work = step("work", {
            run: (_inputs, context) => {
              context.log.log("executed-type-only-step");
              return context.options.message;
            },
          });
          export default defineProject("type-only-project", [
            definePipeline({ id: "type-only", steps: [work] }),
          ]);
        `
      );
      const io = { ...captureIo(directory), signal: AbortSignal.timeout(1_000) };
      const args =
        command === "run"
          ? ["run", "type-only"]
          : ["ui", "--store", path.join(directory, "runs.sqlite"), "--port", "0", projectFile];

      expect(await runWorkbenchCli(args, io)).toBe(TUBELESS_WORKBENCH_EXIT_CODE.load);
      expect(io.errors.join("")).toContain('Cannot derive a CLI for project pipeline "type-only"');
      expect(io.errors.join("")).toContain("Standard JSON Schema input metadata");
      expect(io.errors.join("")).toContain("explicit params");
      expect(io.errors.join("")).toContain("defineCommandCatalog");
      expect(io.output.join("")).not.toContain("executed-type-only-step");
      expect(io.output.join("")).not.toContain("Tubeless local studio:");

      for (const operation of ["list", "inspect", "plan", "graph"]) {
        const planIo = captureIo(directory);
        const planArgs = operation === "list" ? [operation] : [operation, "type-only"];
        expect(await runWorkbenchCli(planArgs, planIo)).toBe(TUBELESS_WORKBENCH_EXIT_CODE.success);
        expect(planIo.errors).toEqual([]);
        expect(planIo.output.join("")).not.toContain("executed-type-only-step");
      }
    }
  );

  it("lists and runs project pipelines with automatically inferred CLI flags", async () => {
    const { directory, projectFile } = await writeAutomaticProjectFixture();

    const listIo = captureIo(directory);
    expect(await runWorkbenchCli(["list", "--json"], listIo)).toBe(
      TUBELESS_WORKBENCH_EXIT_CODE.success
    );
    expect(JSON.parse(listIo.output.join(""))).toEqual({
      id: "fixture-project",
      name: "Fixture jobs",
      description: "Print a message.",
      pipelines: ["automatic"],
      project: projectFile,
    });

    const runIo = captureIo(directory);
    expect(await runWorkbenchCli(["run", "automatic", "--", "--message", "hello"], runIo)).toBe(
      TUBELESS_WORKBENCH_EXIT_CODE.success
    );
    expect(runIo.output.join(" ")).toContain("worked:hello");
    expect(runIo.errors).toEqual([]);

    const inspectIo = captureIo(directory);
    expect(await runWorkbenchCli(["inspect", "automatic", "--json"], inspectIo)).toBe(
      TUBELESS_WORKBENCH_EXIT_CODE.success
    );
    const inspection = JSON.parse(inspectIo.output.join(""));
    expect(inspection.pipelineId).toBe("automatic");
    expect(inspection).not.toHaveProperty("commandId");

    const textIo = captureIo(directory);
    expect(await runWorkbenchCli(["inspect", "automatic"], textIo)).toBe(
      TUBELESS_WORKBENCH_EXIT_CODE.success
    );
    expect(textIo.output.join("")).toContain("Pipeline automatic");
    expect(textIo.output.join("")).not.toContain("Command automatic");
  });

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

    const textIo = captureIo(directory);
    expect(await runWorkbenchCli(["list"], textIo)).toBe(TUBELESS_WORKBENCH_EXIT_CODE.success);
    expect(textIo.output.join("")).toBe(
      "import-data\t./pipeline.mjs#FixtureCommand\tImport data\n"
    );
  });

  it("rejects the same module from a direct file and catalog before importing it", async () => {
    const { directory, manifest } = await writeProjectFixture();
    const cliModuleUrl = pathToFileURL(path.resolve("dist/cli/cli.js")).href;
    await writeFile(
      manifest,
      `
        import { defineCommandCatalog } from ${JSON.stringify(cliModuleUrl)};
        export default defineCommandCatalog({
          cwd: "./work",
          commands: [{ id: "alias", file: "../config/../pipeline.mjs" }],
        });
      `
    );
    await rm(path.join(directory, "pipeline.mjs"));
    const io = captureIo(directory);

    expect(await runWorkbenchCli(["ui", "--command", "./pipeline.mjs", manifest], io)).toBe(
      TUBELESS_WORKBENCH_EXIT_CODE.usage
    );
    expect(io.errors.join("")).toContain(
      `Studio command source ${JSON.stringify(path.join(directory, "pipeline.mjs"))} is duplicated.`
    );
    expect(io.output).toEqual([]);
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
        "--export cannot be combined with --project; the project file owns export selection."
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
    const cliModuleUrl = pathToFileURL(path.resolve("dist/cli/cli.js")).href;
    const manifest = path.join(directory, "config", "duplicate.mjs");
    await writeFile(
      manifest,
      `
        import { defineCommandCatalog } from ${JSON.stringify(cliModuleUrl)};
        export default defineCommandCatalog({ commands: [
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

  it("publishes project pipelines and inferred parameters to Studio", async () => {
    const { directory, projectFile } = await writeAutomaticProjectFixture();
    const controller = new AbortController();
    const io = { ...captureIo(directory), signal: controller.signal };
    const running = runWorkbenchCli(
      ["ui", "--store", path.join(directory, "runs.sqlite"), "--port", "0", projectFile],
      io
    );

    await vi.waitFor(() => expect(io.output.join(" ")).toContain("Tubeless local studio: http://"));
    const url = /Tubeless local studio: (http:\/\/[^\n]+)/.exec(io.output.join(""))?.[1];
    expect(url).toBeDefined();
    await expect(fetch(`${url}/api/commands`).then((response) => response.json())).resolves.toEqual(
      {
        commands: [
          expect.objectContaining({
            id: "automatic",
            name: "automatic",
            parameters: expect.arrayContaining([
              expect.objectContaining({ flag: "message", key: "message", required: true }),
            ]),
          }),
        ],
      }
    );

    controller.abort();
    await expect(running).resolves.toBe(TUBELESS_WORKBENCH_EXIT_CODE.success);
  });
});
