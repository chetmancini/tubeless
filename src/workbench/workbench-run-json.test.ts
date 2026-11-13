import { readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { runCommand } from "./workbench-run.js";
import { TUBELESS_WORKBENCH_EXIT_CODE } from "./workbench-shared.js";
import {
  captureIo,
  parseNdjson,
  writeActualPipelineCommandModule,
  writeModule,
} from "./workbench.test-support.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function commandFixture() {
  const fixture = await writeActualPipelineCommandModule();
  directories.push(fixture.directory);
  return fixture;
}

async function valueFixture(expression: string) {
  const pipelineUrl = pathToFileURL(path.resolve("dist/core/pipeline.js")).href;
  const cliUrl = pathToFileURL(path.resolve("dist/cli/cli.js")).href;
  const fixture = await writeModule(`
    import { createSteps, definePipeline } from ${JSON.stringify(pipelineUrl)};
    import { definePipelineCommand } from ${JSON.stringify(cliUrl)};
    const { step } = createSteps();
    const work = step("work", { run: () => (${expression}) });
    export const pipeline = definePipeline({ id: "json-value", steps: [work], finalize: work });
    export const command = definePipelineCommand(pipeline, { params: {}, reporter: false });
  `);
  directories.push(fixture.directory);
  return fixture;
}

describe("run --json", () => {
  it.each([
    ["bun", "workbench-bin.js"],
    ["node", "workbench-bin.js"],
    ["node", "workbench-launcher.js"],
  ])("keeps noisy imports and handlers off JSON stdout through %s %s", async (runtime, entry) => {
    const { directory, filePath } = await valueFixture(`(() => {
      console.log("handler console");
      console.info("handler info");
      console.debug("handler debug");
      process.stdout.write("handler stdout\\n");
      setTimeout(() => console.log("late console"), 20);
      return { answer: 42 };
    })()`);
    await writeFile(
      path.join(directory, "noisy.mjs"),
      `
      import nodeConsole, { log } from "node:console";
      console.log("import console");
      nodeConsole.log("import console module");
      log("import named log");
      process.stdout.write("import stdout\\n");
    `
    );
    await writeFile(filePath, `import "./noisy.mjs";\n${await readFile(filePath, "utf8")}`);
    const result = spawnSync(
      runtime,
      [path.resolve("dist/workbench", entry), "run", "--json", filePath],
      {
        encoding: "utf8",
        timeout: 10_000,
      }
    );
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      pipelineId: "json-value",
      status: "completed",
      finalized: true,
      value: { answer: 42 },
    });
    for (const message of [
      "import console",
      "import console module",
      "import named log",
      "import stdout",
      "handler console",
      "handler info",
      "handler debug",
      "handler stdout",
      "late console",
    ]) {
      expect(result.stderr).toContain(message);
    }
  });

  it("keeps import noise off stdout even when loading fails", async () => {
    const { filePath } = await valueFixture("null");
    await writeFile(filePath, `console.log("load noise"); throw new Error("load failure");`);
    const result = spawnSync(
      "bun",
      ["dist/workbench/workbench-bin.js", "run", "--json", filePath],
      {
        encoding: "utf8",
        timeout: 10_000,
      }
    );
    expect(result.status).toBe(TUBELESS_WORKBENCH_EXIT_CODE.load);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("load noise");
    expect(result.stderr).toContain("load failure");
  });

  it("leaves application --json flags after the separator in text mode", async () => {
    const { filePath } = await valueFixture('(console.log("text mode console"), 42)');
    const source = (await readFile(filePath, "utf8")).replace(
      "params: {}",
      'params: { json: { type: "boolean" } }'
    );
    await writeFile(filePath, source);
    const result = spawnSync(
      "bun",
      ["dist/workbench/workbench-bin.js", "run", filePath, "--", "--json"],
      {
        encoding: "utf8",
        timeout: 10_000,
      }
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("text mode console");
    expect(result.stderr).toBe("");
  });

  it("prints the public run record and keeps logs and summaries on stderr", async () => {
    const { directory } = await commandFixture();
    const io = captureIo(directory);
    expect(await runCommand(["--json", "pipeline.mjs", "--", "--message", "hello"], io)).toBe(0);
    const run = JSON.parse(io.output.join(""));
    expect(run).toMatchObject({
      pipelineId: "command-fixture",
      status: "completed",
      finalized: true,
      value: "hello",
      dryRun: false,
      errors: [],
      steps: [{ id: "work", status: "completed" }],
    });
    expect(run.runId).toEqual(expect.any(String));
    expect(run.version).toEqual(expect.any(Number));
    expect(run.finishedAtMs).toBeGreaterThanOrEqual(run.startedAtMs);
    expect(io.output).toHaveLength(1);
    expect(io.errors.join("")).toContain("worked:hello");
    expect(io.errors.join("")).toContain("completed:hello");
  });

  it("prints failed reports with JSON-safe causes and the existing exit code", async () => {
    const { directory } = await valueFixture(`(() => {
      throw new Error("outer", { cause: Object.assign(new Error("inner"), { code: "BROKEN" }) });
    })()`);
    const io = captureIo(directory);
    expect(await runCommand(["--json", "pipeline.mjs"], io)).toBe(
      TUBELESS_WORKBENCH_EXIT_CODE.execution
    );
    const run = JSON.parse(io.output.join(""));
    expect(run).toMatchObject({
      status: "failed",
      finalized: false,
      errors: [
        {
          code: "TUBELESS_STEP_FAILED",
          stepId: "work",
          message: "outer",
          cause: { name: "Error", message: "inner", sourceCode: "BROKEN" },
        },
      ],
      steps: [{ id: "work", status: "failed", error: { message: "outer" } }],
    });
    expect(io.errors.join("")).toContain("outer");
  });

  it("prints the cancelled report even when the execution signal is aborted", async () => {
    const { directory, filePath } = await commandFixture();
    const { started } = await import(pathToFileURL(filePath).href);
    const controller = new AbortController();
    const io = { ...captureIo(directory), signal: controller.signal };
    const pending = runCommand(
      ["--json", "pipeline.mjs", "--", "--message", "hello", "--mode", "wait"],
      io
    );
    await started;
    controller.abort();
    expect(await pending).toBe(TUBELESS_WORKBENCH_EXIT_CODE.cancellation);
    expect(JSON.parse(io.output.join(""))).toMatchObject({
      status: "cancelled",
      finalized: false,
      steps: [{ id: "work", status: "cancelled" }],
    });
  });

  it("returns the same record for dry runs", async () => {
    const { directory } = await commandFixture();
    const io = captureIo(directory);
    expect(
      await runCommand(["--json", "pipeline.mjs", "--", "--message", "preview", "--dry-run"], io)
    ).toBe(0);
    expect(JSON.parse(io.output.join(""))).toMatchObject({
      status: "completed",
      dryRun: true,
      finalized: true,
      value: "preview",
    });
  });

  it("rejects --trace - before loading or executing a module", async () => {
    const io = captureIo("/unused");
    expect(await runCommand(["--json", "--trace", "-", "absent.mjs"], io)).toBe(
      TUBELESS_WORKBENCH_EXIT_CODE.usage
    );
    expect(io.output).toEqual([]);
    expect(io.errors.join("")).toContain("--json cannot be combined with --trace -");
  });

  it.each([
    [["--help"], TUBELESS_WORKBENCH_EXIT_CODE.success],
    [[], TUBELESS_WORKBENCH_EXIT_CODE.validation],
  ])("keeps stdout empty when parsing produces no run (%j)", async (args, exitCode) => {
    const { directory } = await commandFixture();
    const io = captureIo(directory);
    expect(await runCommand(["--json", "pipeline.mjs", "--", ...args], io)).toBe(exitCode);
    expect(io.output).toEqual([]);
    expect(io.errors.join("")).toContain("Usage:");
  });

  it("composes with trace recording and prints the root report for nested pipelines", async () => {
    const pipelineUrl = pathToFileURL(path.resolve("dist/core/pipeline.js")).href;
    const cliUrl = pathToFileURL(path.resolve("dist/cli/cli.js")).href;
    const { directory } = await writeModule(`
      import { createSteps, definePipeline } from ${JSON.stringify(pipelineUrl)};
      import { definePipelineCommand } from ${JSON.stringify(cliUrl)};
      const { step, fromPipeline } = createSteps();
      const work = step("work", { run: () => ({ answer: 42 }) });
      const child = definePipeline({ id: "child", steps: [work], finalize: work });
      const nested = fromPipeline("nested", { pipeline: child });
      const pipeline = definePipeline({ id: "parent", steps: [nested], finalize: nested });
      export const command = definePipelineCommand(pipeline, {
        params: {}, reporter: { mode: "interactive", color: "never", symbols: "ascii" },
      });
    `);
    directories.push(directory);
    const io = captureIo(directory);
    expect(await runCommand(["--json", "--trace", "run.ndjson", "pipeline.mjs"], io)).toBe(0);
    const run = JSON.parse(io.output.join(""));
    expect(run).toMatchObject({ pipelineId: "parent", finalized: true, value: { answer: 42 } });
    expect(io.output.join("")).not.toContain("\u001B[");
    expect(io.errors.join("")).toContain("Pipeline parent");
    const events = parseNdjson(await readFile(path.join(directory, "run.ndjson"), "utf8"));
    expect(events.at(-1)).toMatchObject({ name: "pipeline.completed", runId: run.runId });
    expect(events.some((event) => event.pipelineId === "child")).toBe(true);
  });

  it("supports automatic commands from project IDs without a library change", async () => {
    const { directory, filePath } = await valueFixture("null");
    const projectUrl = pathToFileURL(path.resolve("dist/project/project.js")).href;
    await writeFile(
      filePath,
      `
      import { defineProject } from ${JSON.stringify(projectUrl)};
      import { ValidatedPipeline } from ${JSON.stringify(pathToFileURL(path.resolve("examples/validated-boundaries.ts")).href)};
      export default defineProject("json-project", [ValidatedPipeline]);
    `
    );
    const io = captureIo(directory);
    expect(
      await runCommand(
        ["--json", "--project", "pipeline.mjs", "validated-import", "--", "--source", "rows.txt"],
        io
      )
    ).toBe(0);
    expect(JSON.parse(io.output.join(""))).toMatchObject({
      pipelineId: "validated-import",
      finalized: true,
      value: { count: 1, source: "rows.txt", validated: true },
    });
  });

  it.each([
    "undefined",
    "123n",
    "new Map([[1, 2]])",
    "new Set([1])",
    "new Date()",
    "new (class Result { count = 1 })()",
    "NaN",
    "Infinity",
    "-0",
    "({ missing: undefined })",
    "[undefined]",
    "Array(1)",
    "(() => 1)",
    "(() => { const cycle = {}; cycle.self = cycle; return cycle; })()",
  ])("rejects lossy finalized values without printing partial JSON: %s", async (expression) => {
    const { directory } = await valueFixture(expression);
    const io = captureIo(directory);
    expect(await runCommand(["--json", "pipeline.mjs"], io)).toBe(
      TUBELESS_WORKBENCH_EXIT_CODE.execution
    );
    expect(io.output).toEqual([]);
    expect(io.errors.join("")).toContain(
      "--json cannot represent the finalized value without data loss"
    );
  });

  it.each(["null", "true", "42", '"hello"', "({ rows: [1, null, false, { name: 'a' }] })"])(
    "preserves JSON data: %s",
    async (expression) => {
      const { directory } = await valueFixture(expression);
      const io = captureIo(directory);
      expect(await runCommand(["--json", "pipeline.mjs"], io)).toBe(0);
      expect(JSON.parse(io.output.join(""))).toMatchObject({ finalized: true });
    }
  );

  it("reports stdout write failures through the execution exit code", async () => {
    const { directory } = await commandFixture();
    const io = captureIo(directory);
    const output = new Writable({
      write(_chunk, _encoding, callback) {
        callback(new Error("broken JSON output"));
      },
    });
    output.on("error", () => {});
    expect(
      await runCommand(["--json", "pipeline.mjs", "--", "--message", "hello"], {
        ...io,
        stdout: output,
      })
    ).toBe(TUBELESS_WORKBENCH_EXIT_CODE.execution);
    expect(io.errors.join("")).toContain("broken JSON output");
  });
});
