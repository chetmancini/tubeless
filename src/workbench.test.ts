import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { defineCommand, definePipelineCommand } from "./cli";
import { selectPipelineCommandExport, selectPipelineExport } from "./pipeline-module";
import { createSteps, definePipeline } from "./pipeline";
import { openSqlitePipelineRunStore } from "./run-store-sqlite";
import { TUBELESS_WORKBENCH_EXIT_CODE, runWorkbenchCli, type WorkbenchCliIo } from "./workbench";

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

async function writeStudioConfig(directory: string): Promise<void> {
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
          export: "FixtureCommand",
          name: "Studio fixture",
        }],
      });
    `
  );
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
        descriptor: { name: "fixture", parameters: [] },
        plan: () => ({
          dryRun: false,
          errors: [],
          ok: true,
          pipelineId: "from-command",
          steps: [],
        }),
        parse: () => ({ kind: "values" }),
        run: async () => undefined,
      });
    `);
    const io = captureIo(directory);

    const exitCode = await runWorkbenchCli(["plan", "--json", "pipeline.mjs"], io);

    expect(exitCode).toBe(TUBELESS_WORKBENCH_EXIT_CODE.success);
    expect(JSON.parse(io.output.join(""))).toMatchObject({ pipelineId: "from-command" });
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
    ).resolves.toEqual({ canClearHistory: true });
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
      body: JSON.stringify({ dryRun: true, step: [], target: ["work"] }),
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
      body: JSON.stringify({ values: { message: "from-studio", target: ["work"] } }),
      headers: { "content-type": "application/json", "x-tubeless-studio-launch": "1" },
      method: "POST",
    });
    expect(launched.status).toBe(202);
    const launch = (await launched.json()) as { runId: string };
    expect(launch.runId).toContain("command-fixture");
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
    const onceSpy = vi.spyOn(process, "once");
    const removeListenerSpy = vi.spyOn(process, "removeListener");

    try {
      const runPromise = runWorkbenchCli(
        ["run", "pipeline.mjs", "--", "--message", "hello", "--mode", "wait"],
        io
      );
      const fixture = (await import(pathToFileURL(filePath).href)) as { started: Promise<void> };
      await fixture.started;
      const registration = onceSpy.mock.calls.find(([event]) => event === "SIGINT");
      expect(registration).toBeDefined();
      (registration?.[1] as () => void)();

      expect(await runPromise).toBe(TUBELESS_WORKBENCH_EXIT_CODE.cancellation);
      expect(io.errors.join("")).toContain("SIGINT received; cancelling pipeline work.");
      expect(removeListenerSpy.mock.calls).toContainEqual(["SIGINT", registration?.[1]]);
    } finally {
      onceSpy.mockRestore();
      removeListenerSpy.mockRestore();
    }
  });

  it("preserves a structured execution failure that races with SIGINT", async () => {
    const { directory, filePath } = await writeActualPipelineCommandModule();
    const io = captureIo(directory);
    const onceSpy = vi.spyOn(process, "once");

    try {
      const runPromise = runWorkbenchCli(
        ["run", "pipeline.mjs", "--", "--message", "hello", "--mode", "fail-after-abort"],
        io
      );
      const fixture = (await import(pathToFileURL(filePath).href)) as { started: Promise<void> };
      await fixture.started;
      const registration = onceSpy.mock.calls.find(([event]) => event === "SIGINT");
      expect(registration).toBeDefined();
      (registration?.[1] as () => void)();

      expect(await runPromise).toBe(TUBELESS_WORKBENCH_EXIT_CODE.execution);
      expect(io.errors.join("")).toContain("TUBELESS_STEP_FAILED");
      expect(io.errors.join("")).toContain("intentional failure after abort");
    } finally {
      onceSpy.mockRestore();
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
    expect(await runWorkbenchCli(["ui", "--help"], uiIo)).toBe(
      TUBELESS_WORKBENCH_EXIT_CODE.success
    );
    expect(topLevelIo.output.join("")).toContain("tubeless inspect");
    expect(topLevelIo.output.join("")).toContain("tubeless plan");
    expect(topLevelIo.output.join("")).toContain("tubeless graph");
    expect(topLevelIo.output.join("")).toContain("tubeless run");
    expect(inspectIo.output.join("")).toContain("--json");
    expect(inspectIo.output.join("")).not.toContain("direction");
    expect(planIo.output.join("")).toContain("--target <id>");
    expect(planIo.output.join("")).toContain("--explain");
    expect(runIo.output.join("")).toContain("definePipelineCommand");
    expect(uiIo.output.join("")).toContain("append-only SQLite run store");
    expect(uiIo.output.join("")).toContain("--command <path>");
  });
});
