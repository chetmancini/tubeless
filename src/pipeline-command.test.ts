import { describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { openCheckpoint } from "./checkpoint";
import { definePipelineCommand, type CliContext } from "./cli";
import { createSteps, definePipeline, type ReporterOutput } from "./pipeline";
import { renderPipelinePlan } from "./render";

interface MiniOptions {
  limit?: number;
}

function testLog(): CliContext["log"] & { lines: { level: string; message: string }[] } {
  const lines: { level: string; message: string }[] = [];
  return {
    lines,
    log: (message) => lines.push({ level: "log", message: String(message) }),
    warn: (message) => lines.push({ level: "warn", message: String(message) }),
    error: (message) => lines.push({ level: "error", message: String(message) }),
  };
}

function makeMiniPipeline(onRun: (options: MiniOptions, dryRun: boolean) => void = () => {}) {
  const step = createSteps<MiniOptions>();
  const first = step("first", {
    name: "First Step",
    description: "Run first",
    run: (_inputs, context) => {
      onRun(context.options, context.dryRun);
      return context.options.limit ?? 1;
    },
  });
  const second = step("second", {
    description: "Run second",
    run: (_inputs, context) => {
      onRun(context.options, context.dryRun);
      return 2;
    },
  });
  return definePipeline({
    id: "mini",
    steps: [first, second],
    targets: [first, second],
    finalize: (outputs) => ({ first: outputs.first, second: outputs.second }),
  });
}

describe("definePipelineCommand", () => {
  it("defaults to no domain options without leaking command-only values", async () => {
    const seen: MiniOptions[] = [];
    const command = definePipelineCommand(
      makeMiniPipeline((options) => seen.push(options)),
      {
        reporter: false,
      }
    );

    await command.run(["--dry-run"]);

    expect(seen[0]).toEqual({});
    expect(seen[0]).not.toHaveProperty("continueOnError");
    expect(seen[0]).not.toHaveProperty("dryRun");
    expect(seen[0]).not.toHaveProperty("plan");
    expect(seen[0]).not.toHaveProperty("resume");
    expect(seen[0]).not.toHaveProperty("step");
    expect(seen[0]).not.toHaveProperty("stepIds");
    expect(seen[0]).not.toHaveProperty("target");
    expect(seen[0]).not.toHaveProperty("targets");
  });

  it("defaults same-name validated flags into compatible required domain options", async () => {
    interface DirectOptions {
      count?: number;
      label: string;
    }
    let seen: DirectOptions | undefined;
    const step = createSteps<DirectOptions>();
    const work = step("work", {
      run: (_inputs, context) => {
        seen = context.options;
        return context.options.label.repeat(context.options.count ?? 1);
      },
    });
    const pipeline = definePipeline({
      id: "direct-options",
      steps: [work],
      targets: [work],
      finalize: (outputs) => outputs.work,
    });
    const command = definePipelineCommand(pipeline, {
      params: {
        count: { type: "number", optional: true },
        label: { type: "string" },
      },
      reporter: false,
    });

    await expect(command.run(["--label", "go", "--count", "2", "--target", "work"])).resolves.toBe(
      "gogo"
    );
    expect(seen).toEqual({ count: 2, label: "go" });
    expect(seen).not.toHaveProperty("target");
  });

  it("adds pipeline flags and step choices to generated help", () => {
    const command = definePipelineCommand(makeMiniPipeline(), { mapOptions: () => ({}) });
    const result = command.parse(["--help"]);

    expect(result.kind).toBe("help");
    if (result.kind !== "help") return;
    expect(result.helpText).toContain("--step <string...>");
    expect(result.helpText).toContain("--target <string...>");
    expect(result.helpText).toContain("one of: first, second");
    expect(result.helpText).toContain("--continue-on-error");
    expect(result.helpText).not.toContain("--plan");
    expect(
      command.descriptor.parameters
        .filter((parameter) => parameter.group === "execution")
        .map((parameter) => parameter.key)
    ).toEqual(["dryRun", "resume", "stepIds", "continueOnError", "targets"]);
  });

  it("plans from selection controls without requiring domain parameters", () => {
    const command = definePipelineCommand(makeMiniPipeline(), {
      params: { source: { type: "path" } },
      mapOptions: () => ({}),
    });

    const plan = command.plan({ dryRun: true, targets: ["first"] });

    expect(plan).toMatchObject({
      dryRun: true,
      ok: true,
      pipelineId: "mini",
      steps: [
        { id: "first", selected: true },
        { id: "second", selected: false, skipReason: "filtered" },
      ],
    });
  });

  it("forwards PipelineRunControls to pipeline.plan without remapping empty arrays", () => {
    const command = definePipelineCommand(makeMiniPipeline(), { mapOptions: () => ({}) });
    const pipeline = makeMiniPipeline();

    const empty = command.plan({ stepIds: [] });
    expect(empty.ok).toBe(false);
    expect(empty.errors[0]?.code).toBe("TUBELESS_PLANNING_STEP_SELECTION_EMPTY");
    expect(empty.errors[0]?.code).toBe(pipeline.plan({ stepIds: [] }).errors[0]?.code);

    const conflict = command.plan({ stepIds: ["first"], targets: ["second"] });
    expect(conflict.errors[0]?.code).toBe("TUBELESS_PLANNING_SELECTION_CONFLICT");
  });

  it("exposes the owned pipeline identity and static graph", () => {
    const pipeline = makeMiniPipeline();
    const command = definePipelineCommand(pipeline, { mapOptions: () => ({}) });

    expect(command.id).toBe(pipeline.id);
    expect(command.stepIds).toBe(pipeline.stepIds);
    expect(command.targetIds).toBe(pipeline.targetIds);
    expect(command.toMermaid()).toBe(pipeline.toMermaid());
    expect(command.toMermaid({ direction: "LR", includeDescriptions: true })).toBe(
      pipeline.toMermaid({ direction: "LR", includeDescriptions: true })
    );
  });

  it("omits --target when a pipeline declares no public targets", () => {
    const step = createSteps();
    const internal = step("internal", { run: () => true });
    const pipeline = definePipeline({
      id: "no-targets",
      steps: [internal],
      finalize: (outputs) => outputs.internal,
    });
    const command = definePipelineCommand(pipeline, { mapOptions: () => ({}) });
    const result = command.parse(["--help"]);

    expect(pipeline.targetIds).toEqual([]);
    expect(result.kind === "help" && result.helpText).not.toContain("--target");

    const undeclared = command.plan({ targets: ["internal"] });
    expect(undeclared.ok).toBe(false);
    expect(undeclared.errors[0]?.code).toBe("TUBELESS_PLANNING_TARGET_UNDECLARED");
  });

  it("offers only declared targets while retaining every exact step choice", () => {
    const step = createSteps();
    const internal = step("internal", { run: () => true });
    const release = step("release", {
      dependsOn: [internal],
      run: () => true,
    });
    const pipeline = definePipeline({
      id: "public-targets",
      steps: [internal, release],
      targets: [release],
      finalize: (outputs) => outputs.release,
    });
    const command = definePipelineCommand(pipeline, { mapOptions: () => ({}) });

    const help = command.parse(["--help"]);
    expect(help.kind === "help" && help.helpText).toContain(
      "Run exactly this step. Steps: internal, release"
    );
    expect(help.kind === "help" && help.helpText).toContain(
      "Run this declared target and its prerequisites. Targets: release"
    );
    const invalid = command.parse(["--target", "internal"]);
    expect(invalid.kind === "error" && invalid.errors[0]).toContain("one of: release");
  });

  it("forwards repeated step selection and omits stepIds when no step is selected", async () => {
    const seen: MiniOptions[] = [];
    const pipeline = makeMiniPipeline((options) => seen.push(options));
    const command = definePipelineCommand(pipeline, { mapOptions: () => ({}), reporter: false });

    await command.run(["--step", "first", "--step", "second"]);
    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toHaveProperty("stepIds");

    seen.length = 0;
    await command.run([]);
    expect(seen).toHaveLength(2);
    expect(Object.prototype.hasOwnProperty.call(seen[0], "stepIds")).toBe(false);
  });

  it("forwards dependency-aware target selection", async () => {
    const seen: MiniOptions[] = [];
    const command = definePipelineCommand(
      makeMiniPipeline((options) => seen.push(options)),
      {
        mapOptions: () => ({}),
        reporter: false,
      }
    );

    await command.run(["--target", "first"]);

    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toHaveProperty("targets");
    expect(Object.prototype.hasOwnProperty.call(seen[0], "stepIds")).toBe(false);
  });

  it("rejects combining exact steps with dependency-aware targets", () => {
    const command = definePipelineCommand(makeMiniPipeline(), { mapOptions: () => ({}) });
    const result = command.parse(["--step", "first", "--target", "second"]);

    expect(result.kind).toBe("error");
    expect(result.kind === "error" && result.errors).toContain(
      "--step and --target cannot be used together."
    );
  });

  it("forwards an explicit CLI signal into pipeline step contexts", async () => {
    const controller = new AbortController();
    let seenSignal: AbortSignal | undefined;
    const step = createSteps();
    const work = step("work", {
      run: (_inputs, context) => {
        seenSignal = context.signal;
        return "done";
      },
    });
    const pipeline = definePipeline({
      id: "signal-forwarding",
      steps: [work],
      finalize: (outputs) => outputs.work,
    });
    const command = definePipelineCommand(pipeline, { mapOptions: () => ({}), reporter: false });

    await command.run([], { signal: controller.signal });

    expect(seenSignal).toBe(controller.signal);
  });

  it("creates and cleans up a SIGINT signal for main entrypoints", async () => {
    let seenSignal: AbortSignal | undefined;
    const step = createSteps();
    const work = step("work", {
      run: (_inputs, context) => {
        seenSignal = context.signal;
        return "done";
      },
    });
    const pipeline = definePipeline({
      id: "main-signal",
      steps: [work],
      finalize: (outputs) => outputs.work,
    });
    const command = definePipelineCommand(pipeline, { mapOptions: () => ({}), reporter: false });
    const log = testLog();
    const onceSpy = vi.spyOn(process, "once");
    const removeListenerSpy = vi.spyOn(process, "removeListener");

    try {
      await command.main([], { log });
    } finally {
      const onceCalls = onceSpy.mock.calls.slice();
      const removeListenerCalls = removeListenerSpy.mock.calls.slice();
      onceSpy.mockRestore();
      removeListenerSpy.mockRestore();

      const sigintRegistration = onceCalls.find(([event]) => event === "SIGINT");
      expect(sigintRegistration).toBeDefined();
      expect(seenSignal).toBeInstanceOf(AbortSignal);
      expect(removeListenerCalls).toContainEqual(["SIGINT", sigintRegistration?.[1]]);
    }
  });

  it("aborts a main pipeline when its SIGINT handler fires", async () => {
    let resolveStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    let seenSignal: AbortSignal | undefined;
    let ranAfterCancellation = false;
    const step = createSteps();
    const wait = step("wait", {
      run: async (_inputs, context) => {
        if (!context.signal) throw new Error("expected a managed CLI signal");
        seenSignal = context.signal;
        resolveStarted?.();
        await new Promise<void>((resolve) => {
          context.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        return "done";
      },
    });
    const after = step("after", {
      dependsOn: [wait],
      run: () => {
        ranAfterCancellation = true;
        return "after";
      },
    });
    const pipeline = definePipeline({
      id: "main-signal-abort",
      steps: [wait, after],
      finalize: (outputs) => outputs.after ?? outputs.wait,
    });
    const command = definePipelineCommand(pipeline, { mapOptions: () => ({}), reporter: false });
    const log = testLog();
    const previousExitCode = process.exitCode;
    const onceSpy = vi.spyOn(process, "once");

    try {
      const runPromise = command.main([], { log });
      await started;
      const registration = onceSpy.mock.calls.find(([event]) => event === "SIGINT");
      expect(registration).toBeDefined();
      (registration?.[1] as () => void)();
      await runPromise;
    } finally {
      const observedExitCode = process.exitCode;
      process.exitCode = previousExitCode;
      onceSpy.mockRestore();

      expect(observedExitCode).toBe(130);
    }

    expect(seenSignal?.aborted).toBe(true);
    expect(ranAfterCancellation).toBe(false);
    expect(log.lines.some(({ message }) => message.includes("SIGINT received"))).toBe(true);
  });

  it("keeps the SIGINT exit code when pipeline cleanup returns normally", async () => {
    let resolveStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    const step = createSteps();
    const cleanup = step("cleanup", {
      run: async (_inputs, context) => {
        if (!context.signal) throw new Error("expected a managed CLI signal");
        resolveStarted?.();
        await new Promise<void>((resolve) => {
          context.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        return "cleaned up";
      },
    });
    const pipeline = definePipeline({
      id: "normal-sigint-cleanup",
      steps: [cleanup],
      finalize: (outputs) => outputs.cleanup,
    });
    const command = definePipelineCommand(pipeline, { mapOptions: () => ({}), reporter: false });
    const log = testLog();
    const previousExitCode = process.exitCode;
    const onceSpy = vi.spyOn(process, "once");

    try {
      const runPromise = command.main([], { log });
      await started;
      const registration = onceSpy.mock.calls.find(([event]) => event === "SIGINT");
      expect(registration).toBeDefined();
      (registration?.[1] as () => void)();
      await runPromise;
      expect(process.exitCode).toBe(130);
    } finally {
      process.exitCode = previousExitCode;
      onceSpy.mockRestore();
    }
  });

  it("rejects unknown steps during CLI parsing", () => {
    const command = definePipelineCommand(makeMiniPipeline(), { mapOptions: () => ({}) });
    const result = command.parse(["--step", "missing"]);

    expect(result.kind).toBe("error");
    expect(result.kind === "error" && result.errors[0]).toContain("one of: first, second");
  });

  it("prints a plan without running pipeline steps", () => {
    let ran = false;
    const command = definePipelineCommand(
      makeMiniPipeline(() => {
        ran = true;
      }),
      { mapOptions: () => ({}) }
    );

    const plan = command.plan({ stepIds: ["first"] });
    expect(ran).toBe(false);
    expect(renderPipelinePlan(plan).split("\n")).toEqual([
      "Pipeline mini: plan (ok=true, dryRun=false, steps=2)",
      "  - First Step [first]: run (exact selection) - Run first",
      "  - second: skip: filtered (not selected) - Run second",
    ]);
  });

  it("returns a structured planning failure without running steps", () => {
    let ran = false;
    const command = definePipelineCommand(
      makeMiniPipeline(() => {
        ran = true;
      }),
      { mapOptions: () => ({}), reporter: false }
    );

    const plan = command.plan({ targets: ["first", "first"] });

    expect(plan.ok).toBe(false);
    expect(plan.errors[0]).toMatchObject({
      code: "TUBELESS_PLANNING_TARGET_SELECTION_DUPLICATE",
      kind: "selection",
      phase: "planning",
    });
    expect(renderPipelinePlan(plan)).toContain("plan (ok=false");
    expect(ran).toBe(false);
  });

  it("explains target closure selection in plan output", () => {
    const step = createSteps();
    const source = step("source", { run: () => "source" });
    const hint = step("hint", { run: () => "hint" });
    const publish = step("publish", {
      dependsOn: [source],
      optionalDependsOn: [hint],
      run: () => "published",
    });
    const pipeline = definePipeline({
      id: "explained-target",
      steps: [source, hint, publish],
      targets: [publish],
      finalize: (outputs) => outputs.publish,
    });
    const command = definePipelineCommand(pipeline, {
      mapOptions: () => ({}),
      reporter: false,
    });

    const plan = command.plan({ targets: ["publish"] });

    expect(renderPipelinePlan(plan).split("\n")).toEqual([
      "Pipeline explained-target: plan (ok=true, dryRun=false, steps=3)",
      "  - source: run (required by publish for target publish)",
      "  - hint: skip: filtered (optional-only input to publish for target publish)",
      "  - publish: run (target publish)",
    ]);
  });

  it("forwards dry-run, continue-on-error, and mapped user params", async () => {
    const seen: MiniOptions[] = [];
    const dryRuns: boolean[] = [];
    const command = definePipelineCommand(
      makeMiniPipeline((options, dryRun) => {
        seen.push(options);
        dryRuns.push(dryRun);
      }),
      {
        params: {
          limit: { type: "number", optional: true, integer: true, min: 1 },
        },
        mapOptions: (values) => ({ limit: values.limit }),
        reporter: false,
      }
    );

    const result = await command.run(["--dry-run", "--continue-on-error", "--limit", "4"]);
    expect(result).toEqual({ first: 4, second: 2 });
    expect(seen[0]).toEqual({ limit: 4 });
    expect(dryRuns).toEqual([true, true]);
  });

  it("attaches the reporter by default and can disable it", async () => {
    const defaultLog = testLog();
    const defaultCommand = definePipelineCommand(makeMiniPipeline(), { mapOptions: () => ({}) });
    await defaultCommand.run([], { log: defaultLog });
    expect(defaultLog.lines.some((line) => line.message.includes("Pipeline mini: starting"))).toBe(
      true
    );

    const quietLog = testLog();
    const quietCommand = definePipelineCommand(makeMiniPipeline(), {
      mapOptions: () => ({}),
      reporter: false,
    });
    await quietCommand.run([], { log: quietLog });
    expect(quietLog.lines).toEqual([]);
  });

  it("configures reporter styling and resolves user hook factories", async () => {
    const log = testLog();
    const completed: string[] = [];
    const command = definePipelineCommand(makeMiniPipeline(), {
      hooks: ({ context, values }) => [
        {
          onStepComplete: ({ step }) => completed.push(`${context.cwd}:${values.limit}:${step.id}`),
        },
      ],
      mapOptions: (values) => ({ limit: values.limit }),
      params: { limit: { type: "number", optional: true } },
      reporter: { color: "never", symbols: "unicode" },
    });

    await command.run(["--limit", "3"], { cwd: "/workspace", log });

    expect(log.lines.map((line) => line.message)).toEqual(
      expect.arrayContaining([
        "  → First Step - Run first",
        expect.stringMatching(/^  ✓ First Step \(\d+ms\)$/),
      ])
    );
    expect(completed).toEqual(["/workspace:3:first", "/workspace:3:second"]);
  });

  it("routes pipeline and hook logs through the interactive renderer", async () => {
    const chunks: string[] = [];
    const output: ReporterOutput = {
      isTTY: true,
      write: (chunk) => chunks.push(chunk),
    };
    const cliLog = testLog();
    const step = createSteps();
    const work = step("work", {
      run: (_inputs, context) => {
        context.reportProgress({ completed: 3, total: 4, message: "items" });
        context.log.log("step detail");
        return "done";
      },
    });
    const pipeline = definePipeline({
      id: "interactive-command",
      steps: [work],
      finalize: (outputs) => outputs.work,
    });
    const command = definePipelineCommand(pipeline, {
      hooks: ({ context }) => {
        context.log.log("hook configured");
        return undefined;
      },
      mapOptions: () => ({}),
      reporter: {
        color: "never",
        mode: "interactive",
        output,
        progressBarWidth: 8,
        refreshIntervalMs: 10_000,
        symbols: "unicode",
        terminal: { color: false, isTTY: true, unicode: true },
      },
      summarize: () => ["summary after renderer"],
    });

    await command.run([], { log: cliLog });

    const rendered = chunks.join("");
    expect(rendered).toContain("hook configured\n");
    expect(rendered).toContain("step detail\n");
    expect(rendered).toContain("[██████░░] 75% 3/4 items");
    expect(rendered).toContain("\u001B[?25h");
    expect(cliLog.lines).toEqual([{ level: "log", message: "summary after renderer" }]);
  });

  it("logs domain summary lines after a successful run", async () => {
    const log = testLog();
    const command = definePipelineCommand(makeMiniPipeline(), {
      mapOptions: () => ({}),
      reporter: false,
      summarize: (result) => [`first=${result.first}`],
    });

    await command.run([], { log });
    expect(log.lines.map((line) => line.message)).toEqual(["first=1"]);
  });

  it("rejects bridge parameter and flag collisions at definition time", () => {
    expect(() =>
      definePipelineCommand(makeMiniPipeline(), {
        params: { stepIds: { type: "string" } as never },
        mapOptions: () => ({}),
      })
    ).toThrow(/"stepIds" is a reserved parameter/);

    expect(() =>
      definePipelineCommand(makeMiniPipeline(), {
        params: { step: { type: "string" } as never },
        mapOptions: () => ({}),
      })
    ).toThrow(/--step is a reserved flag/);

    expect(() =>
      definePipelineCommand(makeMiniPipeline(), {
        params: { stage: { type: "string", flag: "continue-on-error" } },
        mapOptions: () => ({}),
      })
    ).toThrow(/--continue-on-error is a reserved flag/);
  });

  it("does not reserve a ghost plan parameter or --plan flag", () => {
    const command = definePipelineCommand(makeMiniPipeline(), {
      params: { plan: { type: "boolean" } },
      mapOptions: () => ({}),
    });
    const result = command.parse(["--plan"]);

    expect(result.kind).toBe("values");
    expect(result.kind === "values" && result.values.plan).toBe(true);
  });

  it("treats --plan as an unknown pipeline-command flag", () => {
    const command = definePipelineCommand(makeMiniPipeline(), { mapOptions: () => ({}) });
    const result = command.parse(["--plan"]);

    expect(result.kind).toBe("error");
    expect(result.kind === "error" && result.errors).toContain("Unknown option: --plan");
  });

  it("maps command.main validation, planning, execution, and cancellation onto workbench exit codes", async () => {
    const previousExitCode = process.exitCode;
    const log = testLog();

    try {
      const command = definePipelineCommand(makeMiniPipeline(), {
        mapOptions: () => ({}),
        reporter: false,
      });

      process.exitCode = undefined;
      await command.main(["--help"], { log });
      expect(process.exitCode).toBe(0);

      process.exitCode = undefined;
      await command.main(["--bogus"], { log });
      expect(process.exitCode).toBe(4);

      process.exitCode = undefined;
      await command.main(["--target", "first", "--target", "first"], { log });
      expect(process.exitCode).toBe(5);

      const failingStep = createSteps();
      const fail = failingStep("fail", {
        run: () => {
          throw new Error("intentional command failure");
        },
      });
      const failingCommand = definePipelineCommand(
        definePipeline({
          id: "main-failure",
          steps: [fail],
          finalize: (outputs) => outputs.fail,
        }),
        { mapOptions: () => ({}), reporter: false }
      );
      process.exitCode = undefined;
      await failingCommand.main([], { log });
      expect(process.exitCode).toBe(6);

      const cancellingStep = createSteps();
      const cancel = cancellingStep("cancel", {
        run: () => {
          throw new DOMException("intentional command cancellation", "AbortError");
        },
      });
      const cancellingCommand = definePipelineCommand(
        definePipeline({
          id: "main-cancellation",
          steps: [cancel],
          finalize: (outputs) => outputs.cancel,
        }),
        { mapOptions: () => ({}), reporter: false }
      );
      process.exitCode = undefined;
      await cancellingCommand.main([], { log });
      expect(process.exitCode).toBe(7);

      const throwingCommand = definePipelineCommand(makeMiniPipeline(), {
        mapOptions: () => {
          throw new Error("mapOptions failed");
        },
        reporter: false,
      });
      process.exitCode = undefined;
      await throwingCommand.main([], { log });
      expect(process.exitCode).toBe(6);

      const throwingValidateCommand = definePipelineCommand(makeMiniPipeline(), {
        mapOptions: () => ({}),
        validate: () => {
          throw new Error("validate failed");
        },
        reporter: false,
      });
      process.exitCode = undefined;
      await throwingValidateCommand.main([], { log });
      expect(process.exitCode).toBe(6);
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it("plans without opening or mutating a managed checkpoint", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-command-plan-"));
    const checkpointPath = path.join(cwd, "checkpoint.json");
    let validationCalls = 0;
    try {
      const checkpoint = openCheckpoint(checkpointPath);
      checkpoint.record("existing");
      checkpoint.flush();

      const command = definePipelineCommand(makeMiniPipeline(), {
        checkpoint: { path: checkpointPath },
        mapOptions: () => ({}),
        validate: () => {
          validationCalls += 1;
        },
      });
      const plan = command.plan();

      expect(plan.ok).toBe(true);
      expect(openCheckpoint(checkpointPath).has("existing")).toBe(true);
      expect(validationCalls).toBe(0);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});
