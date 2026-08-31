import { describe, expect, it } from "vitest";
import { createSteps, definePipeline, type PipelineLogger } from "./pipeline";
import { createRunReporter } from "./reporter";

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
  const step = createSteps();
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
});
