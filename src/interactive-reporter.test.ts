import { afterEach, describe, expect, it, vi } from "vitest";
import { createPipelineReporter, type ReporterOutput } from "./interactive-reporter";
import { createSteps, definePipeline, type PipelineLogger } from "./pipeline";

function captureOutput(isTTY = true, columns = 100): ReporterOutput & { chunks: string[] } {
  const chunks: string[] = [];
  return {
    chunks,
    columns,
    isTTY,
    write: (chunk) => chunks.push(chunk),
  };
}

function captureLog(): PipelineLogger & { messages: string[] } {
  const messages: string[] = [];
  return {
    messages,
    error: (message) => messages.push(`error:${String(message)}`),
    log: (message) => messages.push(`log:${String(message)}`),
    warn: (message) => messages.push(`warn:${String(message)}`),
  };
}

function progressivePipeline() {
  const step = createSteps();
  const load = step("load", {
    run: (_inputs, context) => {
      context.reportProgress({ completed: 4, total: 10, message: "records" });
      context.log.log("loaded a batch");
      context.reportProgress({ completed: 12, total: 10, message: "finishing" });
      return "loaded";
    },
  });
  const write = step("write", {
    dependsOn: [load],
    run: () => "written",
  });
  return definePipeline({
    id: "interactive-test",
    steps: [load, write],
    finalize: (outputs) => outputs.write,
  });
}

function detailedPipeline() {
  const step = createSteps();
  const fanOut = step("fan-out", {
    run: (_inputs, context) => {
      context.reportProgress({
        completed: 1,
        total: 4,
        message: "1/4 items · 2 running (max 2)",
        details: [
          { id: "shard-b", label: "write", status: "running" },
          { id: "shard-a", label: "parse", status: "running" },
        ],
      });
      return "done";
    },
  });
  return definePipeline({
    id: "detail-test",
    steps: [fanOut],
    finalize: (outputs) => outputs["fan-out"],
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("createPipelineReporter", () => {
  it("redraws progress in place, preserves logs, and restores the cursor", async () => {
    const output = captureOutput();
    const fallbackLog = captureLog();
    const reporter = createPipelineReporter({
      color: "never",
      log: fallbackLog,
      mode: "interactive",
      output,
      progressBarWidth: 10,
      refreshIntervalMs: 10_000,
      symbols: "unicode",
      terminal: { color: false, isTTY: true, unicode: true },
    });

    const result = await progressivePipeline().run(
      {},
      { cwd: "/tmp", hooks: reporter.hooks, log: reporter.log }
    );
    reporter.dispose();

    const rendered = output.chunks.join("");
    expect(result.status).toBe("completed");
    expect(reporter.mode).toBe("interactive");
    expect(rendered).toContain("\u001B[?25l");
    expect(rendered).toContain("\u001B[?25h");
    expect(rendered).toMatch(/\u001B\[\d+F\u001B\[J/);
    expect(rendered).toContain("[████░░░░░░] 40% 4/10 records");
    expect(rendered).toContain("[██████████] 100% 12/10 finishing");
    expect(rendered).toContain("loaded a batch\n");
    expect(rendered).toMatch(/✓ load \(\d+ms\)/);
    expect(rendered).toMatch(
      /Pipeline interactive-test: done in \d+ms \(status=completed, steps=2, errors=0\)/
    );
    expect(rendered.match(/\u001B\[\?25h/g)).toHaveLength(1);
    expect(fallbackLog.messages).toEqual([]);
  });

  it("renders progress details as indented child rows", async () => {
    const output = captureOutput();
    const reporter = createPipelineReporter({
      color: "never",
      log: captureLog(),
      mode: "interactive",
      output,
      progressBarWidth: 10,
      refreshIntervalMs: 10_000,
      symbols: "unicode",
      terminal: { color: false, isTTY: true, unicode: true },
    });

    await detailedPipeline().run({}, { cwd: "/tmp", hooks: reporter.hooks, log: reporter.log });
    reporter.dispose();

    const rendered = output.chunks.join("");
    expect(rendered).toContain("fan-out");
    expect(rendered).toContain("1/4 items · 2 running (max 2)");
    // Indented child rows under the parent step.
    expect(rendered).toMatch(/\n {4}[^\n]*shard-b[^\n]*write/);
    expect(rendered).toMatch(/\n {4}[^\n]*shard-a[^\n]*parse/);
  });

  it("uses the plain reporter when auto mode has no interactive TTY", async () => {
    const output = captureOutput(false);
    const log = captureLog();
    const reporter = createPipelineReporter({
      color: "never",
      log,
      mode: "auto",
      output,
      symbols: "ascii",
      terminal: { isTTY: false },
    });

    await progressivePipeline().run({}, { cwd: "/tmp", hooks: reporter.hooks, log: reporter.log });

    expect(reporter.mode).toBe("plain");
    expect(output.chunks).toEqual([]);
    expect(log.messages).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Pipeline interactive-test: starting"),
        "log:loaded a batch",
      ])
    );
  });

  it("uses ASCII bars and keeps live rows inside narrow terminals", async () => {
    const output = captureOutput(true, 25);
    const reporter = createPipelineReporter({
      color: "never",
      log: captureLog(),
      mode: "interactive",
      output,
      progressBarWidth: 8,
      refreshIntervalMs: 10_000,
      symbols: "ascii",
      terminal: { color: false, isTTY: true, unicode: false },
    });

    await progressivePipeline().run({}, { cwd: "/tmp", hooks: reporter.hooks, log: reporter.log });

    const rendered = output.chunks.join("");
    const frameLines = output.chunks
      .filter((chunk) => chunk.endsWith("\n"))
      .flatMap((chunk) => chunk.trimEnd().split("\n"));
    expect(rendered).toContain("[===-----] 40%");
    expect(frameLines.some((line) => line.endsWith("…"))).toBe(true);
    expect(frameLines.every((line) => [...line].length <= 24)).toBe(true);
  });

  it("preserves ANSI styling when a live row is truncated", async () => {
    const output = captureOutput(true, 25);
    const reporter = createPipelineReporter({
      color: "always",
      log: captureLog(),
      mode: "interactive",
      output,
      refreshIntervalMs: 10_000,
      symbols: "unicode",
      terminal: { color: true, isTTY: true, unicode: true },
    });

    await progressivePipeline().run({}, { cwd: "/tmp", hooks: reporter.hooks, log: reporter.log });

    expect(output.chunks.join("")).toContain("\u001B[32mPipeline interactive-te\u001B[0m…");
  });

  it("keeps multi-line errors on one live frame row", async () => {
    const output = captureOutput();
    const reporter = createPipelineReporter({
      color: "never",
      log: captureLog(),
      mode: "interactive",
      output,
      refreshIntervalMs: 10_000,
      symbols: "ascii",
    });
    const step = createSteps();
    const fail = step("fail", {
      run: () => {
        throw new Error("first line\nsecond line");
      },
    });
    const pipeline = definePipeline({ id: "failure", steps: [fail], finalize: () => undefined });

    await pipeline.run({}, { cwd: "/tmp", hooks: reporter.hooks, log: reporter.log });

    const rendered = output.chunks.join("");
    expect(rendered).toContain("fail fail: first line second line");
    expect(rendered).not.toContain("first line\nsecond line");
  });

  it("renders a step's display name instead of its id", async () => {
    const output = captureOutput();
    const reporter = createPipelineReporter({
      color: "never",
      log: captureLog(),
      mode: "interactive",
      output,
      refreshIntervalMs: 10_000,
      symbols: "ascii",
    });
    const step = createSteps();
    const normalize = step("normalize-data", {
      name: "Normalize Data",
      run: () => "done",
    });
    const pipeline = definePipeline({
      id: "named",
      steps: [normalize],
      finalize: () => undefined,
    });

    await pipeline.run({}, { cwd: "/tmp", hooks: reporter.hooks, log: reporter.log });

    const rendered = output.chunks.join("");
    expect(rendered).toContain("Normalize Data");
    expect(rendered).not.toContain(" normalize-data ");
  });

  it("removes terminal control sequences from progress and error text", async () => {
    const output = captureOutput();
    const reporter = createPipelineReporter({
      color: "never",
      log: captureLog(),
      mode: "interactive",
      output,
      refreshIntervalMs: 10_000,
      symbols: "ascii",
    });
    const step = createSteps();
    const fail = step("fail", {
      run: (_inputs, context) => {
        context.reportProgress({
          completed: 1,
          message: "record\u001B]2;pwned\u0007 next\u001B[?2004h",
        });
        throw new Error("failure\u001BPsecret\u001B\\ end");
      },
    });
    const pipeline = definePipeline({ id: "unsafe", steps: [fail], finalize: () => undefined });

    await pipeline.run({}, { cwd: "/tmp", hooks: reporter.hooks, log: reporter.log });

    const rendered = output.chunks.join("");
    expect(rendered).toContain("record next");
    expect(rendered).toContain("failure end");
    expect(rendered).not.toContain("pwned");
    expect(rendered).not.toContain("secret");
    expect(rendered).not.toContain("\u001B[?2004h");
  });

  it("removes terminal control sequences from persistent logs", async () => {
    const output = captureOutput();
    const reporter = createPipelineReporter({
      color: "never",
      log: captureLog(),
      mode: "interactive",
      output,
      refreshIntervalMs: 10_000,
      symbols: "ascii",
    });
    const step = createSteps();
    const log = step("log", {
      run: (_inputs, context) => {
        context.log.log("entry\u001B]2;pwned\u0007 \u001B[31mred\u001B[0m");
      },
    });
    const pipeline = definePipeline({ id: "logging", steps: [log], finalize: () => undefined });

    await pipeline.run({}, { cwd: "/tmp", hooks: reporter.hooks, log: reporter.log });

    const rendered = output.chunks.join("");
    expect(rendered).toContain("entry red\n");
    expect(rendered).not.toContain("pwned");
    expect(rendered).not.toContain("\u001B[31m");
  });

  it("avoids interactive auto mode in CI even when the output is a TTY", () => {
    vi.stubEnv("CI", "true");
    const reporter = createPipelineReporter({
      log: captureLog(),
      output: captureOutput(true),
      terminal: { isTTY: true },
    });

    expect(reporter.mode).toBe("plain");
  });

  it("redraws while a long-awaiting step reports no progress", async () => {
    const output = captureOutput();
    const reporter = createPipelineReporter({
      color: "never",
      log: captureLog(),
      mode: "interactive",
      output,
      refreshIntervalMs: 50,
      symbols: "ascii",
      terminal: { color: false, isTTY: true, unicode: false },
    });
    const step = createSteps();
    const slow = step("slow", {
      run: async () => {
        await new Promise((resolve) => setTimeout(resolve, 250));
        return "done";
      },
    });
    const pipeline = definePipeline({
      id: "await-only",
      steps: [slow],
      finalize: (outputs) => outputs.slow,
    });

    await pipeline.run({}, { cwd: "/tmp", hooks: reporter.hooks, log: reporter.log });
    reporter.dispose();

    const liveFrames = output.chunks
      .filter((chunk) => chunk.includes(" slow"))
      .map((chunk) => chunk.replace(/\u001B\[[0-9;]*[A-Za-z]/g, "").trimEnd());
    const runningFrames = liveFrames.filter((frame) => /[-\\|\/] slow/.test(frame));
    const uniqueRunning = new Set(runningFrames);
    // Reporter timer (not kernel progress) must animate spinner/elapsed while live.
    expect(runningFrames.length).toBeGreaterThanOrEqual(2);
    expect(uniqueRunning.size).toBeGreaterThanOrEqual(2);
  });
});
