import { describe, expect, it } from "vitest";
import { createSteps, definePipeline, type PipelineLogger } from "../core/pipeline.js";
import { createRunReporter, formatDurationMs } from "./reporter.js";

function capturingLogger() {
  const messages = { error: [] as string[], log: [] as string[], warn: [] as string[] };
  const logger: PipelineLogger = {
    error: (message) => messages.error.push(String(message)),
    log: (message) => messages.log.push(String(message)),
    warn: (message) => messages.warn.push(String(message)),
  };
  return { logger, messages };
}

function makeReporterPipeline(options: { fail?: boolean; skipWrite?: boolean } = {}) {
  const { step } = createSteps();
  const build = step("build", {
    name: "Build Artifact",
    description: "Build the artifact",
    run: () => {
      if (options.fail) throw new Error("artifact is empty");
      return "built";
    },
  });
  const write = step("write", {
    dependsOn: [build],
    dryRun: options.skipWrite ? "skip" : undefined,
    run: ({ build: value }) => `${value}+written`,
  });
  return definePipeline({
    id: "reported",
    steps: [build, write],
    finalize: (outputs) => outputs.write ?? outputs.build,
  });
}

describe("createRunReporter", () => {
  it("logs a successful pipeline timeline without serializing its value", async () => {
    const { logger, messages } = capturingLogger();
    const result = await makeReporterPipeline().run({}, undefined, {
      cwd: "/tmp",
      hooks: createRunReporter({
        color: "never",
        log: logger,
        symbols: "ascii",
      }),
      log: logger,
    });

    expect(result.status).toBe("completed");
    expect(messages.log).toEqual(
      expect.arrayContaining([
        "Pipeline reported: starting (2 steps, dryRun=false)",
        "  -> Build Artifact - Build the artifact",
        "  -> write",
        expect.stringMatching(/^  ok Build Artifact \(\d+ms\)$/),
        expect.stringMatching(/^  ok finalize \(\d+ms\)$/),
        expect.stringMatching(
          /^Pipeline reported: done in \d+ms \(status=completed, steps=2, errors=0\)$/
        ),
      ])
    );
    expect(messages.log.join("\n")).not.toContain("built+written");
    expect(messages.error).toEqual([]);
  });

  it("logs dry-run skips with their reason", async () => {
    const { logger, messages } = capturingLogger();
    await makeReporterPipeline({ skipWrite: true }).run(
      {},
      { dryRun: true },
      {
        cwd: "/tmp",
        hooks: createRunReporter({ color: "never", log: logger, symbols: "ascii" }),
        log: logger,
      }
    );

    expect(messages.log).toContain("  - write (dry-run)");
  });

  it("logs failed steps and the failed summary at error level", async () => {
    const { logger, messages } = capturingLogger();
    await makeReporterPipeline({ fail: true }).run({}, undefined, {
      cwd: "/tmp",
      hooks: createRunReporter({ color: "never", log: logger, symbols: "ascii" }),
      log: logger,
    });

    expect(messages.error).toContain("  fail Build Artifact: artifact is empty");
    expect(messages.error).toContainEqual(
      expect.stringMatching(
        /^Pipeline reported: done in \d+ms \(status=failed, steps=2, errors=1\)$/
      )
    );
  });

  it("renders cancellation as its own terminal state", async () => {
    const controller = new AbortController();
    controller.abort("stop");
    const { logger, messages } = capturingLogger();

    await makeReporterPipeline().run({}, undefined, {
      cwd: "/tmp",
      hooks: createRunReporter({ color: "never", log: logger, symbols: "ascii" }),
      log: logger,
      signal: controller.signal,
    });

    expect(messages.warn).toContain("  - Build Artifact: cancelled: Pipeline run aborted: stop");
    expect(messages.error).not.toContainEqual(expect.stringContaining("Build Artifact"));
  });

  it("uses Unicode or emoji symbols when configured", async () => {
    const unicode = capturingLogger();
    await makeReporterPipeline().run({}, undefined, {
      cwd: "/tmp",
      hooks: createRunReporter({ color: "never", log: unicode.logger, symbols: "unicode" }),
      log: unicode.logger,
    });
    expect(unicode.messages.log).toEqual(
      expect.arrayContaining([
        "  → Build Artifact - Build the artifact",
        expect.stringMatching(/^  ✓ Build Artifact \(\d+ms\)$/),
      ])
    );

    const emoji = capturingLogger();
    await makeReporterPipeline().run({}, undefined, {
      cwd: "/tmp",
      hooks: createRunReporter({ color: "never", log: emoji.logger, symbols: "emoji" }),
      log: emoji.logger,
    });
    expect(emoji.messages.log).toEqual(
      expect.arrayContaining([expect.stringMatching(/^  ✅ Build Artifact \(\d+ms\)$/)])
    );
  });

  it("honors an explicit Unicode mode when terminal detection disables Unicode", async () => {
    const { logger, messages } = capturingLogger();
    const { step } = createSteps();
    const work = step("work", {
      run: (_inputs, context) => {
        context.reportProgress({ completed: 1, total: 2, message: "items" });
      },
    });
    const pipeline = definePipeline({
      id: "explicit-unicode",
      steps: [work],
      finalize: () => true,
    });

    await pipeline.run({}, undefined, {
      cwd: "/tmp",
      hooks: createRunReporter({
        color: "never",
        log: logger,
        symbols: "unicode",
        terminal: { unicode: false },
      }),
      log: logger,
    });

    expect(messages.log).toContain("  … work 1/2 items");
    expect(messages.log).not.toContain("  ... work 1/2 items");
  });

  it("adds ANSI styling only when color is enabled", async () => {
    const colored = capturingLogger();
    await makeReporterPipeline().run({}, undefined, {
      cwd: "/tmp",
      hooks: createRunReporter({ color: "always", log: colored.logger, symbols: "unicode" }),
      log: colored.logger,
    });
    expect(colored.messages.log.some((message) => message.includes("\u001B["))).toBe(true);

    const plain = capturingLogger();
    await makeReporterPipeline().run({}, undefined, {
      cwd: "/tmp",
      hooks: createRunReporter({
        color: "auto",
        log: plain.logger,
        symbols: "auto",
        terminal: { color: false, isTTY: false, unicode: false },
      }),
      log: plain.logger,
    });
    expect(plain.messages.log.every((message) => !message.includes("\u001B["))).toBe(true);
    expect(plain.messages.log).toContain("  -> Build Artifact - Build the artifact");
  });

  it("sanitizes every plain lifecycle field and uses an ASCII ellipsis", async () => {
    const { logger, messages } = capturingLogger();
    const { step } = createSteps();
    const skipped = step("skip", {
      name: "Skip\u001B]2;owned\u0007 Step",
      skip: () => "cached\u001B[?2004h safely",
      run: () => undefined,
    });
    const fail = step("fail", {
      name: "Fail\u001BPsecret\u001B\\ Step",
      description: "Read\nrows\u001B[31m now\u001B[0m",
      run: (_inputs, context) => {
        context.reportProgress({ completed: 1, message: "one\trow\u009B31m" });
        throw new Error("bad\nvalue\u001B]2;hidden\u0007");
      },
    });
    const pipeline = definePipeline({
      id: "plain\u001B]2;pipeline-title\u0007-safe",
      steps: [skipped, fail],
      finalize: () => undefined,
    });

    await pipeline.run(
      {},
      { continueOnError: true },
      {
        cwd: "/tmp",
        hooks: createRunReporter({
          color: "never",
          log: logger,
          symbols: "ascii",
          terminal: { unicode: false },
        }),
        log: logger,
      }
    );

    const rendered = [...messages.log, ...messages.warn, ...messages.error].join("\n");
    expect(rendered).toContain("Pipeline plain-safe: starting");
    expect(rendered).toContain("Skip Step (cached safely)");
    expect(rendered).toContain("Fail Step - Read rows now");
    expect(rendered).toContain("... Fail Step 1/? one row");
    expect(rendered).toContain("Fail Step: bad value");
    expect(rendered).not.toMatch(/[\u001B\u009B]/);
    expect(rendered).not.toContain("owned");
    expect(rendered).not.toContain("secret");
    expect(rendered).not.toContain("hidden");
    expect(rendered).not.toContain("pipeline-title");
  });
});

describe("formatDurationMs", () => {
  it("carries rounded seconds into the next minute", () => {
    expect(formatDurationMs(59_949)).toBe("59.9s");
    expect(formatDurationMs(59_950)).toBe("1m");
    expect(formatDurationMs(119_499)).toBe("1m59s");
    expect(formatDurationMs(119_500)).toBe("2m");
  });
});
