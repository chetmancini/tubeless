import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { defineCommand, definePipelineCommand } from "./cli";
import { markPipelineCommand } from "./pipeline-command-marker";
import {
  selectPipelineCommandExport,
  selectPipelineExport,
  selectUniqueExport,
} from "./pipeline-module";
import { createSteps, definePipeline } from "./pipeline";
import { projectPipelineRun } from "./run-store";
import { openSqlitePipelineRunStore } from "./run-store-sqlite";
import { DUPLICATE_SIGNAL_WINDOW_MS, onFirstProcessSignal } from "./workbench-shared";
import { TUBELESS_WORKBENCH_EXIT_CODE, runWorkbenchCli, type WorkbenchCliIo } from "./workbench";

function parseNdjson(text: string): { name?: string; pipelineId?: string; runId?: string }[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as { name?: string; pipelineId?: string; runId?: string }];
      } catch {
        return [];
      }
    });
}

function captureIo(cwd: string): WorkbenchCliIo & { errors: string[]; output: string[] } {
  const errors: string[] = [];
  const output: string[] = [];
  return {
    cwd,
    errors,
    output,
    stderr: { write: (chunk) => errors.push(chunk) },
    stdout: { write: (chunk) => output.push(chunk) },
  };
}

async function writeModule(source: string): Promise<{ directory: string; filePath: string }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tubeless-workbench-"));
  const filePath = path.join(directory, "pipeline.mjs");
  await writeFile(filePath, source);
  return { directory, filePath };
}

async function writeActualPipelineModule(): Promise<{ directory: string; filePath: string }> {
  const pipelineModuleUrl = pathToFileURL(path.resolve("dist/pipeline.js")).href;
  return writeModule(`
    import { createSteps, definePipeline } from ${JSON.stringify(pipelineModuleUrl)};
    const step = createSteps();
    const load = step("load", {
      description: "Load source data.",
      run: () => { throw new Error("plan must not execute load"); },
    });
    const hint = step("hint", {
      run: () => { throw new Error("plan must not execute hint"); },
    });
    const publish = step("publish", {
      dependsOn: [load],
      optionalDependsOn: [hint],
      description: "Publish the artifact.",
      dryRun: "skip",
      run: () => { throw new Error("plan must not execute publish"); },
    });
    export const PlanningPipeline = definePipeline({
      id: "planning-fixture",
      steps: [load, hint, publish],
      targets: [publish],
      finalize: () => undefined,
    });
  `);
}

async function writeActualPipelineCommandModule(): Promise<{
  directory: string;
  filePath: string;
}> {
  const cliModuleUrl = pathToFileURL(path.resolve("dist/cli.js")).href;
  const pipelineModuleUrl = pathToFileURL(path.resolve("dist/pipeline.js")).href;
  return writeModule(`
    import { definePipelineCommand } from ${JSON.stringify(cliModuleUrl)};
    import { createSteps, definePipeline, requireOutputs } from ${JSON.stringify(pipelineModuleUrl)};
    let markStarted;
    export const started = new Promise((resolve) => { markStarted = resolve; });
    const step = createSteps();
    const work = step("work", {
      description: "Exercise workbench execution.",
      run: async (_inputs, context) => {
        markStarted();
        if (context.options.mode === "failure") throw new Error("intentional command failure");
        if (context.options.mode === "cancel") {
          throw new DOMException("intentional command cancellation", "AbortError");
        }
        if (context.options.mode === "fail-after-abort") {
          await new Promise((resolve) => {
            if (context.signal?.aborted) return resolve();
            context.signal?.addEventListener("abort", resolve, { once: true });
          });
          throw new Error("intentional failure after abort");
        }
        if (context.options.mode === "wait") {
          await new Promise((_resolve, reject) => {
            if (context.signal?.aborted) return reject(context.signal.reason);
            context.signal?.addEventListener("abort", () => reject(context.signal.reason), { once: true });
          });
        }
        context.log.log(\`worked:\${context.options.message}\`);
        return context.options.message;
      },
    });
    export const CommandPipeline = definePipeline({
      id: "command-fixture",
      steps: [work],
      targets: [work],
      finalize: requireOutputs([work], ({ work }) => work),
    });
    export const FixtureCommand = definePipelineCommand(CommandPipeline, {
      params: {
        message: { type: "string", description: "Message to process." },
        mode: {
          type: "string",
          choices: ["success", "failure", "cancel", "fail-after-abort", "wait"],
          default: "success",
        },
      },
      reporter: false,
      summarize: (result) => [\`completed:\${result}\`],
    });
  `);
}

async function writeStudioConfig(
  directory: string,
  command: { exportName?: string; name?: string } = {}
): Promise<void> {
  const exportName = command.exportName ?? "FixtureCommand";
  const name = command.name ?? "Studio fixture";
  const studioModuleUrl = pathToFileURL(path.resolve("dist/workbench-studio.js")).href;
  const configDirectory = path.join(directory, "config");
  await mkdir(configDirectory);
  await writeFile(
    path.join(configDirectory, "tubeless.studio.mjs"),
    `
      import { definePipelineStudio } from ${JSON.stringify(studioModuleUrl)};
      export default definePipelineStudio({
        cwd: "..",
        commands: [{
          file: "../pipeline.mjs",
          export: ${JSON.stringify(exportName)},
          name: ${JSON.stringify(name)},
        }],
      });
    `
  );
}

async function writeGatedPipelineCommandModule(options: {
  mapOptionsSource: string;
}): Promise<{ directory: string; filePath: string }> {
  const cliModuleUrl = pathToFileURL(path.resolve("dist/cli.js")).href;
  const pipelineModuleUrl = pathToFileURL(path.resolve("dist/pipeline.js")).href;
  return writeModule(`
    import { existsSync } from "node:fs";
    import { definePipelineCommand } from ${JSON.stringify(cliModuleUrl)};
    import { createSteps, definePipeline } from ${JSON.stringify(pipelineModuleUrl)};
    const step = createSteps();
    const work = step("work", {
      description: "No-op gated command.",
      run: () => undefined,
    });
    export const GatedCommand = definePipelineCommand(
      definePipeline({
        id: "gated-fixture",
        steps: [work],
        targets: [work],
        finalize: () => undefined,
      }),
      {
        params: { message: { type: "string" } },
        mapOptions: ${options.mapOptionsSource},
        reporter: false,
      }
    );
  `);
}

const fixturePipeline = `
const steps = [
  {
    dependencies: [],
    description: "Read source rows.",
    dryRun: "run",
    id: "load",
    name: "Load Rows",
    optionalDependencies: [],
    runtimeSkipPossible: false,
    selected: true,
    selectionReasons: [{ kind: "all" }],
    skipAfterFailureOf: [],
  },
  {
    dependencies: ["load"],
    description: "Publish output.",
    dryRun: "skip",
    id: "publish",
    optionalDependencies: ["hint"],
    runtimeSkipPossible: true,
    selected: true,
    selectionReasons: [{ kind: "all" }],
    skipAfterFailureOf: ["validate"],
  },
];
export const FixturePipeline = {
  id: "fixture",
  stepIds: ["load", "publish"],
  targetIds: ["publish"],
  plan: () => ({ dryRun: false, errors: [], ok: true, pipelineId: "fixture", steps }),
  toMermaid(options = {}) {
    const label = options.includeDescriptions ? "Load Rows — Read source rows." : "Load Rows";
    return \`flowchart \${options.direction ?? "TD"}\\n  step0["\${label}"]\\n  step0 --> step1\`;
  },
};
`;

describe("tubeless workbench", () => {
  it("inspects pipeline identity, goals, dependencies, and policies without running it", async () => {
    const { directory } = await writeModule(fixturePipeline);
    const io = captureIo(directory);

    const exitCode = await runWorkbenchCli(["inspect", "pipeline.mjs"], io);

    expect(exitCode).toBe(TUBELESS_WORKBENCH_EXIT_CODE.success);
    expect(io.errors).toEqual([]);
    const rendered = io.output.join("");
    expect(rendered).toContain("Pipeline fixture");
    expect(rendered).toContain("Targets: publish");
    expect(rendered).toContain("Exact steps: load, publish");
    expect(rendered).toContain("Pipeline fixture: plan (ok=true, dryRun=false, steps=2)");
    expect(rendered).toContain("Load Rows [load]: run - Read source rows.");
    expect(rendered).toContain("publish: run - Publish output.");
    expect(rendered).not.toContain("requires:");
  });

  it("emits the inspection as structured JSON", async () => {
    const { directory } = await writeModule(fixturePipeline);
    const io = captureIo(directory);

    const exitCode = await runWorkbenchCli(["inspect", "--json", "pipeline.mjs"], io);

    expect(exitCode).toBe(TUBELESS_WORKBENCH_EXIT_CODE.success);
    expect(JSON.parse(io.output.join(""))).toMatchObject({
      pipelineId: "fixture",
      stepIds: ["load", "publish"],
      targetIds: ["publish"],
      plan: {
        dryRun: false,
        ok: true,
        pipelineId: "fixture",
        steps: [
          { dryRun: "run", id: "load", runtimeSkipPossible: false },
          {
            dependencies: ["load"],
            dryRun: "skip",
            id: "publish",
            runtimeSkipPossible: true,
          },
        ],
      },
    });
  });

  it("graphs a pipeline as raw Mermaid or Markdown", async () => {
    const { directory } = await writeModule(fixturePipeline);
    const rawIo = captureIo(directory);
    const markdownIo = captureIo(directory);

    const rawExit = await runWorkbenchCli(
      ["graph", "--direction", "LR", "--descriptions", "pipeline.mjs"],
      rawIo
    );
    const markdownExit = await runWorkbenchCli(["graph", "pipeline.mjs", "--markdown"], markdownIo);

    expect(rawExit).toBe(TUBELESS_WORKBENCH_EXIT_CODE.success);
    expect(rawIo.output.join("")).toContain("flowchart LR");
    expect(rawIo.output.join("")).toContain("Load Rows — Read source rows.");
    expect(markdownExit).toBe(TUBELESS_WORKBENCH_EXIT_CODE.success);
    expect(markdownIo.output.join("")).toBe(
      ["```mermaid", "flowchart TD", '  step0["Load Rows"]', "  step0 --> step1", "```", ""].join(
        "\n"
      )
    );
  });

  it("plans a target with optional human selection explanations without executing steps", async () => {
    const { directory } = await writeActualPipelineModule();
    const compactIo = captureIo(directory);
    const explainedIo = captureIo(directory);

    const compactExit = await runWorkbenchCli(
      ["plan", "pipeline.mjs", "--target", "publish"],
      compactIo
    );
    const explainedExit = await runWorkbenchCli(
      ["plan", "pipeline.mjs", "--target", "publish", "--explain"],
      explainedIo
    );

    expect(compactExit).toBe(TUBELESS_WORKBENCH_EXIT_CODE.success);
    expect(compactIo.errors).toEqual([]);
    expect(compactIo.output.join("")).toContain("load: run");
    expect(compactIo.output.join("")).toContain("hint: skip: filtered");
    expect(compactIo.output.join("")).not.toContain("required by publish");
    expect(explainedExit).toBe(TUBELESS_WORKBENCH_EXIT_CODE.success);
    expect(explainedIo.output.join("")).toContain(
      "load: run (required by publish for target publish)"
    );
    expect(explainedIo.output.join("")).toContain(
      "hint: skip: filtered (optional-only input to publish for target publish)"
    );
    expect(explainedIo.output.join("")).toContain("publish: run (target publish)");
  });

  it("emits a dry-run plan as complete structured JSON", async () => {
    const { directory } = await writeActualPipelineModule();
    const io = captureIo(directory);

    const exitCode = await runWorkbenchCli(
      ["plan", "--target", "publish", "--dry-run", "--json", "pipeline.mjs"],
      io
    );

    expect(exitCode).toBe(TUBELESS_WORKBENCH_EXIT_CODE.success);
    const plan = JSON.parse(io.output.join(""));
    expect(plan).toMatchObject({
      dryRun: true,
      errors: [],
      ok: true,
      pipelineId: "planning-fixture",
    });
    expect(plan.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "load", selected: true }),
        expect.objectContaining({ id: "hint", selected: false, skipReason: "filtered" }),
        expect.objectContaining({ id: "publish", selected: true, skipReason: "dry-run" }),
      ])
    );
    expect(plan.steps.find(({ id }: { id: string }) => id === "load").selectionReasons).toEqual([
      { dependentId: "publish", kind: "required-dependency", targetId: "publish" },
    ]);
  });

  it("returns the planning exit code with structured selection diagnostics", async () => {
    const { directory } = await writeActualPipelineModule();
    const unknownIo = captureIo(directory);
    const conflictIo = captureIo(directory);

    const unknownExit = await runWorkbenchCli(
      ["plan", "pipeline.mjs", "--target", "missing", "--json"],
      unknownIo
    );
    const conflictExit = await runWorkbenchCli(
      ["plan", "pipeline.mjs", "--target", "publish", "--step", "load"],
      conflictIo
    );

    expect(unknownExit).toBe(TUBELESS_WORKBENCH_EXIT_CODE.planning);
    expect(JSON.parse(unknownIo.output.join("")).errors[0]).toMatchObject({
      code: "TUBELESS_PLANNING_TARGET_UNKNOWN",
      kind: "selection",
      phase: "planning",
    });
    expect(conflictExit).toBe(TUBELESS_WORKBENCH_EXIT_CODE.planning);
    expect(conflictIo.output.join("")).toContain("TUBELESS_PLANNING_SELECTION_CONFLICT");
  });

  it("plans a module that exports only a marked pipeline command", async () => {
    const cliModuleUrl = pathToFileURL(path.resolve("dist/cli.js")).href;
    const pipelineModuleUrl = pathToFileURL(path.resolve("dist/pipeline.js")).href;
    const { directory } = await writeModule(`
      import { definePipelineCommand } from ${JSON.stringify(cliModuleUrl)};
      import { createSteps, definePipeline } from ${JSON.stringify(pipelineModuleUrl)};
      const step = createSteps();
      const work = step("work", {
        run: () => { throw new Error("plan must not execute work"); },
      });
      const pipeline = definePipeline({
        id: "command-only-fixture",
        steps: [work],
        targets: [work],
        finalize: (outputs) => outputs.work,
      });
      export const FixtureCommand = definePipelineCommand(pipeline, {
        mapOptions: () => ({}),
        reporter: false,
      });
    `);
    const io = captureIo(directory);

    const exitCode = await runWorkbenchCli(["plan", "--json", "pipeline.mjs"], io);

    expect(exitCode).toBe(TUBELESS_WORKBENCH_EXIT_CODE.success);
    expect(io.errors).toEqual([]);
    expect(JSON.parse(io.output.join(""))).toMatchObject({
      ok: true,
      pipelineId: "command-only-fixture",
      steps: [expect.objectContaining({ id: "work", selected: true })],
    });
  });

  it("prefers a marked command when a module exports both a pipeline and a command", async () => {
    const markerModuleUrl = pathToFileURL(path.resolve("dist/pipeline-command-marker.js")).href;
    const { directory } = await writeModule(`
      import { markPipelineCommand } from ${JSON.stringify(markerModuleUrl)};
      export const PlanningPipeline = {
        id: "from-pipeline",
        stepIds: ["work"],
        targetIds: ["work"],
        plan: () => ({
          dryRun: false,
          errors: [],
          ok: true,
          pipelineId: "from-pipeline",
          steps: [],
        }),
        toMermaid: () => "flowchart TD",
      };
      export const FixtureCommand = markPipelineCommand({
        id: "from-command",
        stepIds: ["work"],
        targetIds: ["work"],
        descriptor: { name: "fixture", parameters: [] },
        plan: () => ({
          dryRun: false,
          errors: [],
          ok: true,
          pipelineId: "from-command",
          steps: [],
        }),
        parse: () => ({ kind: "values" }),
        parseValues: () => ({ kind: "values" }),
        execute: async () => undefined,
        run: async () => undefined,
        toMermaid: () => "flowchart TD",
      });
    `);
    const io = captureIo(directory);

    const exitCode = await runWorkbenchCli(["plan", "--json", "pipeline.mjs"], io);

    expect(exitCode).toBe(TUBELESS_WORKBENCH_EXIT_CODE.success);
    expect(JSON.parse(io.output.join(""))).toMatchObject({ pipelineId: "from-command" });
  });

  it("inspects a module that exports only a marked pipeline command", async () => {
    const cliModuleUrl = pathToFileURL(path.resolve("dist/cli.js")).href;
    const pipelineModuleUrl = pathToFileURL(path.resolve("dist/pipeline.js")).href;
    const { directory } = await writeModule(`
      import { definePipelineCommand } from ${JSON.stringify(cliModuleUrl)};
      import { createSteps, definePipeline } from ${JSON.stringify(pipelineModuleUrl)};
      const step = createSteps();
      const work = step("work", {
        run: () => { throw new Error("inspect must not execute work"); },
      });
      const pipeline = definePipeline({
        id: "command-only-fixture",
        steps: [work],
        targets: [work],
        finalize: (outputs) => outputs.work,
      });
      export const FixtureCommand = definePipelineCommand(pipeline, {
        mapOptions: () => ({}),
        reporter: false,
      });
    `);
    const io = captureIo(directory);

    const exitCode = await runWorkbenchCli(["inspect", "--json", "pipeline.mjs"], io);

    expect(exitCode).toBe(TUBELESS_WORKBENCH_EXIT_CODE.success);
    expect(io.errors).toEqual([]);
    expect(JSON.parse(io.output.join(""))).toMatchObject({
      pipelineId: "command-only-fixture",
      stepIds: ["work"],
      targetIds: ["work"],
      plan: {
        ok: true,
        pipelineId: "command-only-fixture",
        steps: [expect.objectContaining({ id: "work", selected: true })],
      },
    });
  });

  it("graphs a module that exports only a marked pipeline command", async () => {
    const cliModuleUrl = pathToFileURL(path.resolve("dist/cli.js")).href;
    const pipelineModuleUrl = pathToFileURL(path.resolve("dist/pipeline.js")).href;
    const { directory } = await writeModule(`
      import { definePipelineCommand } from ${JSON.stringify(cliModuleUrl)};
      import { createSteps, definePipeline } from ${JSON.stringify(pipelineModuleUrl)};
      const step = createSteps();
      const work = step("work", {
        name: "Do Work",
        run: () => { throw new Error("graph must not execute work"); },
      });
      export const FixtureCommand = definePipelineCommand(
        definePipeline({
          id: "command-only-graph",
          steps: [work],
          targets: [work],
          finalize: (outputs) => outputs.work,
        }),
        { mapOptions: () => ({}), reporter: false }
      );
    `);
    const io = captureIo(directory);

    const exitCode = await runWorkbenchCli(["graph", "pipeline.mjs"], io);

    expect(exitCode).toBe(TUBELESS_WORKBENCH_EXIT_CODE.success);
    expect(io.errors).toEqual([]);
    expect(io.output.join("")).toBe(["flowchart TD", '  step0["Do Work"]', ""].join("\n"));
  });

  it("prefers a marked command for inspect and graph when a module exports both", async () => {
    const markerModuleUrl = pathToFileURL(path.resolve("dist/pipeline-command-marker.js")).href;
    const { directory } = await writeModule(`
      import { markPipelineCommand } from ${JSON.stringify(markerModuleUrl)};
      export const PlanningPipeline = {
        id: "from-pipeline",
        stepIds: ["work"],
        targetIds: ["work"],
        plan: () => ({
          dryRun: false,
          errors: [],
          ok: true,
          pipelineId: "from-pipeline",
          steps: [],
        }),
        toMermaid: () => "flowchart TD\\n  from-pipeline",
      };
      export const FixtureCommand = markPipelineCommand({
        id: "from-command",
        stepIds: ["command-work"],
        targetIds: ["command-work"],
        descriptor: { name: "fixture", parameters: [] },
        plan: () => ({
          dryRun: false,
          errors: [],
          ok: true,
          pipelineId: "from-command",
          steps: [],
        }),
        parse: () => ({ kind: "values" }),
        parseValues: () => ({ kind: "values" }),
        execute: async () => undefined,
        run: async () => undefined,
        toMermaid: () => "flowchart TD\\n  from-command",
      });
    `);
    const inspectIo = captureIo(directory);
    const graphIo = captureIo(directory);

    const inspectExit = await runWorkbenchCli(["inspect", "--json", "pipeline.mjs"], inspectIo);
    const graphExit = await runWorkbenchCli(["graph", "pipeline.mjs"], graphIo);

    expect(inspectExit).toBe(TUBELESS_WORKBENCH_EXIT_CODE.success);
    expect(JSON.parse(inspectIo.output.join(""))).toMatchObject({
      pipelineId: "from-command",
      stepIds: ["command-work"],
      targetIds: ["command-work"],
    });
    expect(graphExit).toBe(TUBELESS_WORKBENCH_EXIT_CODE.success);
    expect(graphIo.output.join("")).toBe("flowchart TD\n  from-command\n");
  });

  it("runs a discovered pipeline command with application arguments after the boundary", async () => {
    const { directory } = await writeActualPipelineCommandModule();
    const io = captureIo(directory);

    const exitCode = await runWorkbenchCli(
      ["run", "pipeline.mjs", "--", "--message", "hello", "--target", "work"],
      io
    );

    expect(exitCode).toBe(TUBELESS_WORKBENCH_EXIT_CODE.success);
    expect(io.errors).toEqual([]);
    expect(io.output.join("")).toContain("worked:hello");
    expect(io.output.join("")).toContain("completed:hello");
  });

  it("records a run only when the optional SQLite store is requested", async () => {
    const { directory } = await writeActualPipelineCommandModule();
    const io = captureIo(directory);
    const databasePath = path.join(directory, "history", "runs.sqlite");

    const exitCode = await runWorkbenchCli(
      [
        "run",
        "--store",
        databasePath,
        "pipeline.mjs",
        "--",
        "--message",
        "hello",
        "--target",
        "work",
      ],
      io
    );

    expect(exitCode).toBe(TUBELESS_WORKBENCH_EXIT_CODE.success);
    const store = await openSqlitePipelineRunStore(databasePath);
    const events = await store.listEvents();
    await store.close();
    expect(events.map(({ name }) => name)).toEqual([
      "pipeline.started",
      "step.planned",
      "step.running",
      "pipeline.log",
      "step.complete",
      "pipeline.finalize.started",
      "pipeline.finalize.completed",
      "pipeline.completed",
    ]);
    expect(events.find(({ name }) => name === "pipeline.log")).toMatchObject({
      attributes: { level: "log", message: "worked:hello" },
      stepId: "work",
    });
    expect(events.find(({ name }) => name === "step.planned")?.attributes).toMatchObject({
      description: "Exercise workbench execution.",
    });
  });

  it("writes JSON traces from tubeless run without opening a store", async () => {
    const { directory } = await writeActualPipelineCommandModule();
    const io = captureIo(directory);
    const tracePath = path.join(directory, "traces", "run.ndjson");

    const exitCode = await runWorkbenchCli(
      ["run", "--trace", tracePath, "pipeline.mjs", "--", "--message", "hello", "--target", "work"],
      io
    );

    expect(exitCode).toBe(TUBELESS_WORKBENCH_EXIT_CODE.success);
    expect(io.output.join("")).toContain("completed:hello");
    expect(io.output.join("")).not.toContain('"name":"pipeline.started"');
    const events = parseNdjson(await readFile(tracePath, "utf8"));
    expect(events.map(({ name }) => name)).toEqual([
      "pipeline.started",
      "step.planned",
      "step.running",
      "pipeline.log",
      "step.complete",
      "pipeline.finalize.started",
      "pipeline.finalize.completed",
      "pipeline.completed",
    ]);
  });

  it("writes JSON traces to stdout when --trace is -", async () => {
    const { directory } = await writeActualPipelineCommandModule();
    const io = captureIo(directory);

    const exitCode = await runWorkbenchCli(
      ["run", "--trace", "-", "pipeline.mjs", "--", "--message", "hello", "--target", "work"],
      io
    );

    expect(exitCode).toBe(TUBELESS_WORKBENCH_EXIT_CODE.success);
    expect(io.errors.join("")).toContain("completed:hello");
    const stdout = io.output.join("");
    expect(stdout).not.toContain("completed:hello");
    const lines = stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    expect(lines.every((line) => line.startsWith("{"))).toBe(true);
    const events = parseNdjson(stdout);
    expect(events).toHaveLength(lines.length);
    expect(events.map(({ name }) => name)).toContain("pipeline.started");
    expect(events.map(({ name }) => name)).toContain("pipeline.completed");
  });

  it("reports a late write failure from --trace without crashing", async () => {
    const { directory } = await writeActualPipelineCommandModule();
    const io = captureIo(directory);
    const tracePath = path.join(directory, "traces");
    await mkdir(tracePath, { recursive: true });

    const exitCode = await runWorkbenchCli(
      ["run", "--trace", tracePath, "pipeline.mjs", "--", "--message", "hello", "--target", "work"],
      io
    );

    expect(exitCode).toBe(TUBELESS_WORKBENCH_EXIT_CODE.execution);
    expect(io.errors.join("")).toMatch(/EISDIR|directory|Error/i);
  });

  it("records JSON traces and SQLite events together", async () => {
    const { directory } = await writeActualPipelineCommandModule();
    const io = captureIo(directory);
    const databasePath = path.join(directory, "history", "runs.sqlite");
    const tracePath = path.join(directory, "traces", "run.ndjson");

    const exitCode = await runWorkbenchCli(
      [
        "run",
        "--store",
        databasePath,
        "--trace",
        tracePath,
        "pipeline.mjs",
        "--",
        "--message",
        "hello",
        "--target",
        "work",
      ],
      io
    );

    expect(exitCode).toBe(TUBELESS_WORKBENCH_EXIT_CODE.success);
    const store = await openSqlitePipelineRunStore(databasePath);
    const stored = await store.listEvents();
    await store.close();
    const traced = parseNdjson(await readFile(tracePath, "utf8"));
    expect(stored.map(({ name }) => name)).toEqual(traced.map(({ name }) => name));
    expect(traced.map(({ name }) => name)).toContain("pipeline.completed");
  });

  it("rejects the same path for --store and --trace", async () => {
    const { directory } = await writeActualPipelineCommandModule();
    const io = captureIo(directory);
    const sharedPath = path.join(directory, "shared.sqlite");

    const exitCode = await runWorkbenchCli(
      [
        "run",
        "--store",
        sharedPath,
        "--trace",
        sharedPath,
        "pipeline.mjs",
        "--",
        "--message",
        "hello",
        "--target",
        "work",
      ],
      io
    );

    expect(exitCode).toBe(TUBELESS_WORKBENCH_EXIT_CODE.usage);
    expect(io.errors.join("")).toMatch(/same path/i);
  });

  it("rejects a symlink that aliases --store as --trace", async () => {
    const { directory } = await writeActualPipelineCommandModule();
    const io = captureIo(directory);
    const storePath = path.join(directory, "history", "runs.sqlite");
    const tracePath = path.join(directory, "traces", "alias.ndjson");
    expect(
      await runWorkbenchCli(
        [
          "run",
          "--store",
          storePath,
          "pipeline.mjs",
          "--",
          "--message",
          "hello",
          "--target",
          "work",
        ],
        io
      )
    ).toBe(TUBELESS_WORKBENCH_EXIT_CODE.success);
    await mkdir(path.dirname(tracePath), { recursive: true });
    await symlink(storePath, tracePath);

    const aliasIo = captureIo(directory);
    expect(
      await runWorkbenchCli(
        [
          "run",
          "--store",
          storePath,
          "--trace",
          tracePath,
          "pipeline.mjs",
          "--",
          "--message",
          "hello",
          "--target",
          "work",
        ],
        aliasIo
      )
    ).toBe(TUBELESS_WORKBENCH_EXIT_CODE.usage);
    expect(aliasIo.errors.join("")).toMatch(/same path/i);
  });

  it("lists and shows projected history from the run store", async () => {
    const { directory } = await writeActualPipelineCommandModule();
    const io = captureIo(directory);
    const databasePath = path.join(directory, "history", "runs.sqlite");

    expect(
      await runWorkbenchCli(
        [
          "run",
          "--store",
          databasePath,
          "pipeline.mjs",
          "--",
          "--message",
          "hello",
          "--target",
          "work",
        ],
        io
      )
    ).toBe(TUBELESS_WORKBENCH_EXIT_CODE.success);

    const store = await openSqlitePipelineRunStore(databasePath);
    const events = await store.listEvents();
    await store.close();
    const runId = events[0]?.runId;
    expect(runId).toEqual(expect.any(String));

    const listIo = captureIo(directory);
    expect(await runWorkbenchCli(["history", "--store", databasePath], listIo)).toBe(
      TUBELESS_WORKBENCH_EXIT_CODE.success
    );
    expect(listIo.output.join("")).toContain(runId!);
    expect(listIo.output.join("")).toContain("command-fixture");
    expect(listIo.output.join("")).toContain("completed");

    const jsonListIo = captureIo(directory);
    expect(await runWorkbenchCli(["history", "--json", "--store", databasePath], jsonListIo)).toBe(
      TUBELESS_WORKBENCH_EXIT_CODE.success
    );
    expect(JSON.parse(jsonListIo.output.join(""))).toMatchObject({
      runs: [{ pipelineId: "command-fixture", runId, status: "completed" }],
    });

    const showIo = captureIo(directory);
    expect(await runWorkbenchCli(["history", "--store", databasePath, runId!], showIo)).toBe(
      TUBELESS_WORKBENCH_EXIT_CODE.success
    );
    expect(showIo.output.join("")).toContain(runId!);
    expect(showIo.output.join("")).toContain("work");
    expect(showIo.output.join("")).toContain("worked:hello");

    const jsonShowIo = captureIo(directory);
    expect(
      await runWorkbenchCli(["history", "--json", "--store", databasePath, runId!], jsonShowIo)
    ).toBe(TUBELESS_WORKBENCH_EXIT_CODE.success);
    expect(JSON.parse(jsonShowIo.output.join(""))).toMatchObject({
      logs: [expect.objectContaining({ message: "worked:hello", stepId: "work" })],
      pipelineId: "command-fixture",
      runId,
      status: "completed",
      steps: [expect.objectContaining({ id: "work", status: "complete" })],
    });
  });

  it("emits raw store events as NDJSON", async () => {
    const { directory } = await writeActualPipelineCommandModule();
    const io = captureIo(directory);
    const databasePath = path.join(directory, "history", "runs.sqlite");

    expect(
      await runWorkbenchCli(
        [
          "run",
          "--store",
          databasePath,
          "pipeline.mjs",
          "--",
          "--message",
          "hello",
          "--target",
          "work",
        ],
        io
      )
    ).toBe(TUBELESS_WORKBENCH_EXIT_CODE.success);

    const store = await openSqlitePipelineRunStore(databasePath);
    const stored = await store.listEvents();
    await store.close();
    const runId = stored[0]?.runId;

    const eventsIo = captureIo(directory);
    expect(await runWorkbenchCli(["history", "--events", "--store", databasePath], eventsIo)).toBe(
      TUBELESS_WORKBENCH_EXIT_CODE.success
    );
    const listed = parseNdjson(eventsIo.output.join(""));
    expect(listed.map(({ name }) => name)).toEqual(stored.map(({ name }) => name));

    const scopedIo = captureIo(directory);
    expect(
      await runWorkbenchCli(["history", "--events", "--store", databasePath, runId!], scopedIo)
    ).toBe(TUBELESS_WORKBENCH_EXIT_CODE.success);
    expect(parseNdjson(scopedIo.output.join("")).every((event) => event.runId === runId)).toBe(
      true
    );
  });

  it("reads history from the default studio store path", async () => {
    const { directory } = await writeActualPipelineCommandModule();
    const io = captureIo(directory);

    expect(
      await runWorkbenchCli(
        [
          "run",
          "--store",
          ".tubeless/runs.sqlite",
          "pipeline.mjs",
          "--",
          "--message",
          "hello",
          "--target",
          "work",
        ],
        io
      )
    ).toBe(TUBELESS_WORKBENCH_EXIT_CODE.success);

    const historyIo = captureIo(directory);
    expect(await runWorkbenchCli(["history"], historyIo)).toBe(
      TUBELESS_WORKBENCH_EXIT_CODE.success
    );
    expect(historyIo.output.join("")).toContain("command-fixture");
  });

  it("rejects a missing store, unknown run, and combined json/events flags", async () => {
    const { directory } = await writeActualPipelineCommandModule();
    const io = captureIo(directory);
    const databasePath = path.join(directory, "history", "runs.sqlite");

    expect(
      await runWorkbenchCli(
        [
          "run",
          "--store",
          databasePath,
          "pipeline.mjs",
          "--",
          "--message",
          "hello",
          "--target",
          "work",
        ],
        io
      )
    ).toBe(TUBELESS_WORKBENCH_EXIT_CODE.success);

    const missingIo = captureIo(directory);
    expect(
      await runWorkbenchCli(
        ["history", "--store", path.join(directory, "missing.sqlite")],
        missingIo
      )
    ).toBe(TUBELESS_WORKBENCH_EXIT_CODE.load);
    expect(missingIo.errors.join("")).toContain("missing.sqlite");

    const invalidPath = path.join(directory, "not-a-store.sqlite");
    await writeFile(invalidPath, "not sqlite");
    const invalidIo = captureIo(directory);
    expect(await runWorkbenchCli(["history", "--store", invalidPath], invalidIo)).toBe(
      TUBELESS_WORKBENCH_EXIT_CODE.load
    );
    expect(invalidIo.errors.join("")).toMatch(/Error:/);

    const emptyPath = path.join(directory, "empty.sqlite");
    await writeFile(emptyPath, "");
    const emptyIo = captureIo(directory);
    expect(await runWorkbenchCli(["history", "--store", emptyPath], emptyIo)).toBe(
      TUBELESS_WORKBENCH_EXIT_CODE.load
    );
    expect(emptyIo.errors.join("")).toMatch(/not a pipeline run store|Error:/);

    const unknownIo = captureIo(directory);
    expect(
      await runWorkbenchCli(["history", "--store", databasePath, "missing-run"], unknownIo)
    ).toBe(TUBELESS_WORKBENCH_EXIT_CODE.usage);
    expect(unknownIo.errors.join("")).toContain("missing-run");

    const conflictIo = captureIo(directory);
    expect(
      await runWorkbenchCli(["history", "--json", "--events", "--store", databasePath], conflictIo)
    ).toBe(TUBELESS_WORKBENCH_EXIT_CODE.usage);
    expect(conflictIo.errors.join("")).toMatch(/json|events/i);
  });

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

  it("loads and launches explicitly registered commands from a studio config", async () => {
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
        "config/tubeless.studio.mjs",
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
          id: `${path.join(directory, "pipeline.mjs")}#FixtureCommand`,
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
        "config/tubeless.studio.mjs",
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

    const launchPromise = fetch(`${url}/api/commands/${encodeURIComponent(commandId!)}/runs`, {
      body: JSON.stringify({ values: { message: "x" } }),
      headers: { "content-type": "application/json", "x-tubeless-studio-launch": "1" },
      method: "POST",
    });
    const pending = await Promise.race([
      launchPromise.then(() => "resolved" as const),
      new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 80)),
    ]);
    expect(pending).toBe("pending");
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
        "config/tubeless.studio.mjs",
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
      errors: [
        `Pipeline command exited (${TUBELESS_WORKBENCH_EXIT_CODE.execution}) before recording a run.`,
      ],
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
        "config/tubeless.studio.mjs",
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

    const launchPromise = fetch(`${url}/api/commands/${encodeURIComponent(commandId!)}/runs`, {
      body: JSON.stringify({ values: { message: "x" } }),
      headers: { "content-type": "application/json", "x-tubeless-studio-launch": "1" },
      method: "POST",
    });
    const pending = await Promise.race([
      launchPromise.then(() => "resolved" as const),
      new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 80)),
    ]);
    expect(pending).toBe("pending");
    controller.abort();
    const failed = await launchPromise;
    expect(failed.status).toBe(400);
    await expect(failed.json()).resolves.toEqual({
      accepted: false,
      errors: ["The local studio is stopping."],
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
        "config/tubeless.studio.mjs",
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
        ["ui", "--host", "0.0.0.0", "--port", "0", "config/tubeless.studio.mjs"],
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

  it("uses stable validation, planning, execution, and cancellation exit codes", async () => {
    const { directory } = await writeActualPipelineCommandModule();
    const validationIo = captureIo(directory);
    const planningIo = captureIo(directory);
    const executionIo = captureIo(directory);
    const cancellationIo = captureIo(directory);

    const validationExit = await runWorkbenchCli(["run", "pipeline.mjs"], validationIo);
    const planningExit = await runWorkbenchCli(
      ["plan", "pipeline.mjs", "--target", "work", "--target", "work"],
      planningIo
    );
    const executionExit = await runWorkbenchCli(
      ["run", "pipeline.mjs", "--", "--message", "hello", "--mode", "failure"],
      executionIo
    );
    const cancellationExit = await runWorkbenchCli(
      ["run", "pipeline.mjs", "--", "--message", "hello", "--mode", "cancel"],
      cancellationIo
    );

    expect(validationExit).toBe(TUBELESS_WORKBENCH_EXIT_CODE.validation);
    expect(validationIo.errors.join("")).toContain("Missing required option --message");
    expect(planningExit).toBe(TUBELESS_WORKBENCH_EXIT_CODE.planning);
    expect(planningIo.output.join("")).toContain("TUBELESS_PLANNING_TARGET_SELECTION_DUPLICATE");
    expect(executionExit).toBe(TUBELESS_WORKBENCH_EXIT_CODE.execution);
    expect(executionIo.errors.join("")).toContain("TUBELESS_STEP_FAILED");
    expect(executionIo.errors.join("")).toContain("intentional command failure");
    expect(cancellationExit).toBe(TUBELESS_WORKBENCH_EXIT_CODE.cancellation);
    expect(cancellationIo.errors.join("")).toContain("TUBELESS_RUN_CANCELLED");
  });

  it("prints command help only through the application-argument boundary", async () => {
    const { directory } = await writeActualPipelineCommandModule();
    const workbenchHelpIo = captureIo(directory);
    const commandHelpIo = captureIo(directory);

    expect(await runWorkbenchCli(["run", "--help"], workbenchHelpIo)).toBe(
      TUBELESS_WORKBENCH_EXIT_CODE.success
    );
    expect(await runWorkbenchCli(["run", "pipeline.mjs", "--", "--help"], commandHelpIo)).toBe(
      TUBELESS_WORKBENCH_EXIT_CODE.success
    );
    expect(workbenchHelpIo.output.join("")).toContain("Pass application flags after --");
    expect(workbenchHelpIo.output.join("")).not.toContain("--message");
    expect(commandHelpIo.output.join("")).toContain("--message <string>");
  });

  it("rejects raw pipelines and application flags outside the command boundary", async () => {
    const pipelineFixture = await writeActualPipelineModule();
    const rawPipelineIo = captureIo(pipelineFixture.directory);
    const misplacedFlagFixture = await writeActualPipelineCommandModule();
    const misplacedFlagIo = captureIo(misplacedFlagFixture.directory);

    expect(await runWorkbenchCli(["run", "pipeline.mjs"], rawPipelineIo)).toBe(
      TUBELESS_WORKBENCH_EXIT_CODE.load
    );
    expect(rawPipelineIo.errors.join("")).toContain("does not export an tubeless pipeline command");
    expect(
      await runWorkbenchCli(
        ["run", "pipeline.mjs", "--message", "outside-boundary"],
        misplacedFlagIo
      )
    ).toBe(TUBELESS_WORKBENCH_EXIT_CODE.usage);
    expect(misplacedFlagIo.errors.join("")).toContain("Application flags belong after --");
  });

  it("turns SIGINT into cancellation and removes its temporary listener", async () => {
    const { directory, filePath } = await writeActualPipelineCommandModule();
    const io = captureIo(directory);
    const onSpy = vi.spyOn(process, "on");
    const removeListenerSpy = vi.spyOn(process, "removeListener");

    try {
      const runPromise = runWorkbenchCli(
        ["run", "pipeline.mjs", "--", "--message", "hello", "--mode", "wait"],
        io
      );
      const fixture = (await import(pathToFileURL(filePath).href)) as { started: Promise<void> };
      await fixture.started;
      const registration = onSpy.mock.calls.find(([event]) => event === "SIGINT");
      expect(registration).toBeDefined();
      (registration?.[1] as () => void)();

      expect(await runPromise).toBe(TUBELESS_WORKBENCH_EXIT_CODE.cancellation);
      expect(io.errors.join("")).toContain("SIGINT received; cancelling pipeline work.");
      expect(removeListenerSpy.mock.calls).toContainEqual(["SIGINT", registration?.[1]]);
    } finally {
      onSpy.mockRestore();
      removeListenerSpy.mockRestore();
    }
  });

  it("preserves a structured execution failure that races with SIGINT", async () => {
    const { directory, filePath } = await writeActualPipelineCommandModule();
    const io = captureIo(directory);
    const onSpy = vi.spyOn(process, "on");

    try {
      const runPromise = runWorkbenchCli(
        ["run", "pipeline.mjs", "--", "--message", "hello", "--mode", "fail-after-abort"],
        io
      );
      const fixture = (await import(pathToFileURL(filePath).href)) as { started: Promise<void> };
      await fixture.started;
      const registration = onSpy.mock.calls.find(([event]) => event === "SIGINT");
      expect(registration).toBeDefined();
      (registration?.[1] as () => void)();
      // The forwarded duplicate (trampoline + direct terminal delivery)
      // lands inside the swallow window and must not re-trigger anything.
      (registration?.[1] as () => void)();

      expect(await runPromise).toBe(TUBELESS_WORKBENCH_EXIT_CODE.execution);
      expect(io.errors.join("")).toContain("TUBELESS_STEP_FAILED");
      expect(io.errors.join("")).toContain("intentional failure after abort");
      expect(io.errors.join("").match(/SIGINT received/g)).toHaveLength(1);
    } finally {
      onSpy.mockRestore();
    }
  });

  it("re-raises a SIGINT after the duplicate window as a force-quit", async () => {
    const { directory, filePath } = await writeActualPipelineCommandModule();
    const io = captureIo(directory);
    const onSpy = vi.spyOn(process, "on");
    const removeListenerSpy = vi.spyOn(process, "removeListener");
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    try {
      const runPromise = runWorkbenchCli(
        ["run", "pipeline.mjs", "--", "--message", "hello", "--mode", "wait"],
        io
      );
      const fixture = (await import(pathToFileURL(filePath).href)) as { started: Promise<void> };
      await fixture.started;
      const registration = onSpy.mock.calls.find(([event]) => event === "SIGINT");
      expect(registration).toBeDefined();
      (registration?.[1] as () => void)();

      // Past the swallow window, a second SIGINT is a deliberate force-quit:
      // the listener removes itself and re-raises SIGINT on this process so
      // default termination takes over.
      vi.useFakeTimers();
      vi.setSystemTime(Date.now() + DUPLICATE_SIGNAL_WINDOW_MS + 1000);
      (registration?.[1] as () => void)();

      expect(killSpy).toHaveBeenCalledWith(process.pid, "SIGINT");
      expect(removeListenerSpy.mock.calls).toContainEqual(["SIGINT", registration?.[1]]);
      expect(io.errors.join("").match(/SIGINT received/g)).toHaveLength(1);

      // The mocked kill means the run never actually dies; await it so the
      // finally in runCommand still cleans up.
      await runPromise;
    } finally {
      vi.useRealTimers();
      killSpy.mockRestore();
      onSpy.mockRestore();
      removeListenerSpy.mockRestore();
    }
  });

  it("swallows a duplicate queued behind a blocking first dispatch", async () => {
    const events: string[] = [];
    const onSpy = vi.spyOn(process, "on");
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    try {
      const dispose = onFirstProcessSignal(["SIGINT"], () => {
        events.push("first");
        // Simulate >300ms of synchronous cleanup work inside the abort
        // dispatch: the trampoline's duplicate waits behind this call.
        const start = Date.now();
        while (Date.now() - start < 400) {
          // busy-wait
        }
      });
      const registration = onSpy.mock.calls.find(([event]) => event === "SIGINT");
      expect(registration).toBeDefined();
      (registration?.[1] as () => void)(); // first: window arms after return
      (registration?.[1] as () => void)(); // queued duplicate: swallowed

      expect(events).toEqual(["first"]);
      expect(killSpy).not.toHaveBeenCalled();
      dispose();
    } finally {
      killSpy.mockRestore();
      onSpy.mockRestore();
    }
  });

  it("keeps per-signal windows independent across SIGINT and SIGTERM", async () => {
    const events: string[] = [];
    const onSpy = vi.spyOn(process, "on");
    const removeListenerSpy = vi.spyOn(process, "removeListener");
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    try {
      const dispose = onFirstProcessSignal(["SIGINT", "SIGTERM"], (signal) => {
        events.push(signal);
      });
      const sigintRegistration = onSpy.mock.calls.find(([event]) => event === "SIGINT");
      const sigtermRegistration = onSpy.mock.calls.find(([event]) => event === "SIGTERM");
      expect(sigintRegistration).toBeDefined();
      expect(sigtermRegistration).toBeDefined();

      // A SIGINT arms only its own window: a first SIGTERM still gets its
      // graceful first delivery rather than being silenced or force-quit.
      (sigintRegistration?.[1] as () => void)();
      (sigtermRegistration?.[1] as () => void)();
      expect(events).toEqual(["SIGINT", "SIGTERM"]);

      // A post-window second press removes ALL listeners and re-raises:
      // neither signal can fire onFirst again mid-teardown.
      vi.useFakeTimers();
      vi.setSystemTime(Date.now() + DUPLICATE_SIGNAL_WINDOW_MS + 1000);
      (sigintRegistration?.[1] as () => void)();
      expect(killSpy).toHaveBeenCalledWith(process.pid, "SIGINT");
      expect(removeListenerSpy.mock.calls).toContainEqual(["SIGINT", sigintRegistration?.[1]]);
      expect(removeListenerSpy.mock.calls).toContainEqual(["SIGTERM", sigtermRegistration?.[1]]);
      expect(events).toEqual(["SIGINT", "SIGTERM"]);

      dispose();
    } finally {
      vi.useRealTimers();
      killSpy.mockRestore();
      removeListenerSpy.mockRestore();
      onSpy.mockRestore();
    }
  });

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

    const pipeline = {
      id: "same",
      stepIds: [],
      targetIds: [],
      plan: () => ({ dryRun: false, errors: [], ok: true, pipelineId: "same", steps: [] }),
      toMermaid: () => "flowchart TD",
    };
    expect(selectPipelineExport({ Pipeline: pipeline, default: pipeline })).toBe(pipeline);
  });

  it("selects a unique export and can retain its name", () => {
    const isNumber = (value: unknown): value is number => typeof value === "number";
    expect(
      selectUniqueExport({ only: 7, alias: 7, other: "x" }, undefined, isNumber, "number")
    ).toBe(7);
    expect(
      selectUniqueExport({ only: 7, alias: 7, other: "x" }, undefined, isNumber, "number", {
        retainName: true,
      })
    ).toEqual({ exportName: "only", value: 7 });
    expect(
      selectUniqueExport({ First: 1, Second: 2 }, "Second", isNumber, "number", {
        retainName: true,
      })
    ).toEqual({ exportName: "Second", value: 2 });
    expect(() =>
      selectUniqueExport({ First: 1, Second: 2 }, undefined, isNumber, "number")
    ).toThrow("Module exports multiple numbers (First, Second); pass --export <name>.");
    expect(() =>
      selectUniqueExport({ First: 1, Second: 2 }, undefined, isNumber, "number", {
        hintExport: false,
      })
    ).toThrow("Module exports multiple numbers (First, Second).");
  });

  it("discovers only pipeline commands, deduplicates aliases, and supports explicit selection", () => {
    const step = createSteps();
    const work = step("work", { run: () => "done" });
    const pipeline = definePipeline({
      id: "command-selection",
      steps: [work],
      finalize: (outputs) => outputs.work,
    });
    const first = definePipelineCommand(pipeline, { mapOptions: () => ({}), reporter: false });
    const second = definePipelineCommand(pipeline, { mapOptions: () => ({}), reporter: false });
    const generic = defineCommand({ params: {}, run: () => "not a pipeline" });

    expect(selectPipelineCommandExport({ First: first, default: first, Generic: generic })).toBe(
      first
    );
    expect(selectPipelineCommandExport({ First: first, Second: second }, "Second")).toBe(second);
    expect(() => selectPipelineCommandExport({ First: first, Second: second })).toThrow(
      "Module exports multiple pipeline commands (First, Second); pass --export <name>."
    );
    expect(() => selectPipelineCommandExport({ Generic: generic })).toThrow(
      "Module does not export an tubeless pipeline command."
    );
  });

  it("rejects a marked command that is missing structured launch methods", () => {
    const incomplete = markPipelineCommand({
      id: "from-command",
      stepIds: ["work"],
      targetIds: ["work"],
      descriptor: { name: "fixture", parameters: [] },
      plan: () => ({ dryRun: false, errors: [], ok: true, pipelineId: "from-command", steps: [] }),
      parse: () => ({ kind: "values" }),
      run: async () => undefined,
      toMermaid: () => "flowchart TD",
    });
    expect(() => selectPipelineCommandExport({ Incomplete: incomplete })).toThrow(
      "Module does not export an tubeless pipeline command."
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
