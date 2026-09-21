import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  loadPipelineCommandModule,
  loadPlanSourceModule,
  selectUniqueExport,
} from "./pipeline-module.js";
import { TUBELESS_WORKBENCH_EXIT_CODE, runWorkbenchCli } from "./workbench.js";
import {
  captureIo,
  writeActualPipelineCommandModule,
  writeActualPipelineModule,
  writeModule,
} from "./workbench.test-support.js";

describe("workbench module loading and help", () => {
  it("selects a named export and deduplicates aliases", async () => {
    const { directory } = await writeModule(`
      const steps = [];
      const pipeline = (id) => ({
        id,
        stepIds: [],
        targetIds: [],
        plan: () => ({ dryRun: false, errors: [], ok: true, pipelineId: id, steps }),
        toMermaid: () => \`flowchart TD\\n  node["\${id}"]\`,
      });
      export const FirstPipeline = pipeline("first");
      export const SecondPipeline = pipeline("second");
    `);
    const ambiguousIo = captureIo(directory);
    const io = captureIo(directory);

    const ambiguousExitCode = await runWorkbenchCli(["inspect", "pipeline.mjs"], ambiguousIo);
    const exitCode = await runWorkbenchCli(
      ["inspect", "pipeline.mjs", "--export", "SecondPipeline"],
      io
    );

    expect(ambiguousExitCode).toBe(TUBELESS_WORKBENCH_EXIT_CODE.load);
    expect(ambiguousIo.errors.join("")).toContain(
      "Module exports multiple pipelines (FirstPipeline, SecondPipeline); pass --export <name>."
    );
    expect(exitCode).toBe(TUBELESS_WORKBENCH_EXIT_CODE.success);
    expect(io.output.join("")).toContain("Pipeline second");

    const fixture = await writeActualPipelineModule();
    const { filePath } = await writeModule(`
      export { PlanningPipeline, PlanningPipeline as default } from ${JSON.stringify(pathToFileURL(fixture.filePath).href)};
    `);
    await expect(loadPlanSourceModule(filePath)).resolves.toMatchObject({
      kind: "pipeline",
      pipeline: { id: "planning-fixture" },
    });
  });

  it("selects a unique export with its name", () => {
    const isNumber = (value: unknown): value is number => typeof value === "number";
    expect(
      selectUniqueExport({ only: 7, alias: 7, other: "x" }, undefined, isNumber, "number")
    ).toEqual({ exportName: "only", value: 7 });
    expect(selectUniqueExport({ First: 1, Second: 2 }, "Second", isNumber, "number")).toEqual({
      exportName: "Second",
      value: 2,
    });
    expect(() =>
      selectUniqueExport({ First: 1, Second: 2 }, undefined, isNumber, "number")
    ).toThrow("Module exports multiple numbers (First, Second); pass --export <name>.");
    expect(() =>
      selectUniqueExport({ First: 1, Second: 2 }, undefined, isNumber, "number", {
        hintExport: false,
      })
    ).toThrow("Module exports multiple numbers (First, Second).");
  });

  it("discovers only pipeline commands, deduplicates aliases, and supports explicit selection", async () => {
    const fixture = await writeActualPipelineCommandModule();
    const fixtureUrl = JSON.stringify(pathToFileURL(fixture.filePath).href);
    const cliUrl = JSON.stringify(pathToFileURL(path.resolve("dist/cli/cli.js")).href);
    const aliases = await writeModule(`
      export { FixtureCommand as First, FixtureCommand as default } from ${fixtureUrl};
      import { defineCommand } from ${cliUrl};
      export const Generic = defineCommand({ params: {}, run: () => "not a pipeline" });
    `);
    const multiple = await writeModule(`
      import { CommandPipeline } from ${fixtureUrl};
      import { definePipelineCommand } from ${cliUrl};
      export { FixtureCommand as First } from ${fixtureUrl};
      export const Second = definePipelineCommand(CommandPipeline, { reporter: false });
    `);

    await expect(loadPipelineCommandModule(aliases.filePath)).resolves.toMatchObject({
      exportName: "First",
      command: { id: "command-fixture" },
    });
    await expect(loadPipelineCommandModule(multiple.filePath, "Second")).resolves.toMatchObject({
      exportName: "Second",
      command: { id: "command-fixture" },
    });
    await expect(loadPipelineCommandModule(multiple.filePath)).rejects.toThrow(
      "Module exports multiple pipeline commands (First, Second); pass --export <name>."
    );
    const generic = await writeModule(
      `export { Generic } from ${JSON.stringify(pathToFileURL(aliases.filePath).href)};`
    );
    await expect(loadPipelineCommandModule(generic.filePath)).rejects.toThrow(
      "Module does not export a tubeless pipeline command."
    );
  });

  it("rejects a marked command that is missing structured launch methods", async () => {
    const markerUrl = pathToFileURL(path.resolve("dist/utilities/pipeline-command-marker.js")).href;
    const { filePath } = await writeModule(`
      import { markPipelineCommand } from ${JSON.stringify(markerUrl)};
      export const Incomplete = markPipelineCommand({
        id: "from-command",
        stepIds: ["work"],
        targetIds: ["work"],
        descriptor: { name: "fixture", parameters: [] },
        plan: () => ({ dryRun: false, errors: [], ok: true, pipelineId: "from-command", steps: [] }),
        parse: () => ({ kind: "values" }),
        run: async () => undefined,
        toMermaid: () => "flowchart TD",
      }, {});
    `);
    await expect(loadPipelineCommandModule(filePath)).rejects.toThrow(
      "Module does not export a tubeless pipeline command."
    );
  });

  it("uses stable usage, load, and definition exit codes", async () => {
    const usageIo = captureIo("/tmp");
    const loadIo = captureIo("/tmp");
    const definitionFixture = await writeModule(`
      const error = new Error("invalid pipeline fixture");
      error.name = "PipelineDefinitionError";
      throw error;
    `);
    const definitionIo = captureIo(definitionFixture.directory);

    expect(await runWorkbenchCli(["unknown"], usageIo)).toBe(TUBELESS_WORKBENCH_EXIT_CODE.usage);
    expect(await runWorkbenchCli(["inspect", "missing.mjs"], loadIo)).toBe(
      TUBELESS_WORKBENCH_EXIT_CODE.load
    );
    expect(await runWorkbenchCli(["inspect", "pipeline.mjs"], definitionIo)).toBe(
      TUBELESS_WORKBENCH_EXIT_CODE.definition
    );
    expect(usageIo.errors.join("")).toContain("Unknown command");
    expect(loadIo.errors.join("")).toContain("missing.mjs");
    expect(definitionIo.errors.join("")).toContain("invalid pipeline fixture");
  });

  it("prints focused top-level and command help", async () => {
    const topLevelIo = captureIo("/tmp");
    const inspectIo = captureIo("/tmp");
    const planIo = captureIo("/tmp");
    const runIo = captureIo("/tmp");
    const historyIo = captureIo("/tmp");
    const uiIo = captureIo("/tmp");

    expect(await runWorkbenchCli(["--help"], topLevelIo)).toBe(
      TUBELESS_WORKBENCH_EXIT_CODE.success
    );
    expect(await runWorkbenchCli(["inspect", "--help"], inspectIo)).toBe(
      TUBELESS_WORKBENCH_EXIT_CODE.success
    );
    expect(await runWorkbenchCli(["plan", "--help"], planIo)).toBe(
      TUBELESS_WORKBENCH_EXIT_CODE.success
    );
    expect(await runWorkbenchCli(["run", "--help"], runIo)).toBe(
      TUBELESS_WORKBENCH_EXIT_CODE.success
    );
    expect(await runWorkbenchCli(["history", "--help"], historyIo)).toBe(
      TUBELESS_WORKBENCH_EXIT_CODE.success
    );
    expect(await runWorkbenchCli(["ui", "--help"], uiIo)).toBe(
      TUBELESS_WORKBENCH_EXIT_CODE.success
    );
    expect(topLevelIo.output.join("")).toContain("tubeless inspect");
    expect(topLevelIo.output.join("")).toContain("tubeless plan");
    expect(topLevelIo.output.join("")).toContain("tubeless graph");
    expect(topLevelIo.output.join("")).toContain("tubeless run");
    expect(topLevelIo.output.join("")).toContain("tubeless history");
    expect(inspectIo.output.join("")).toContain("--json");
    expect(inspectIo.output.join("")).not.toContain("direction");
    expect(planIo.output.join("")).toContain("--target <id>");
    expect(planIo.output.join("")).toContain("--explain");
    expect(runIo.output.join("")).toContain("definePipelineCommand");
    expect(runIo.output.join("")).toContain("--trace");
    expect(historyIo.output.join("")).toContain("--store");
    expect(historyIo.output.join("")).toContain("--json");
    expect(historyIo.output.join("")).toContain("--events");
    expect(uiIo.output.join("")).toContain("append-only SQLite run store");
    expect(uiIo.output.join("")).toContain("--command <path>");
  });
});
