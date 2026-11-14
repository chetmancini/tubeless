import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { PassThrough, Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runWorkbenchCli } from "../workbench.js";
import { captureIo, execFileAsync, writeModule } from "../workbench.test-support.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const moduleUrl = (name: string) => pathToFileURL(resolve(`dist/${name}.js`)).href;
async function fixture(config = "") {
  return writeModule(`
    import { defineAgent } from ${JSON.stringify(moduleUrl("agent/agent"))};
    let markStarted;
    export const started = new Promise(resolve => { markStarted = resolve; });
    export const Chat = defineAgent({
      id: "fixture-chat", projectContext: false, defaultTools: [],
      model: async (request, context) => {
        if (request.task === "fail") throw new Error("fixture failed");
        if (request.task === "wait") {
          markStarted();
          await new Promise(resolve => context.signal.addEventListener("abort", resolve, {once: true}));
          context.signal.throwIfAborted();
        }
        return {decision: {kind: "finish", result: {answer: request.task + ":" + (request.conversation ?? "fresh") + ":" + context.cwd}}, conversation: request.task};
      }, ${config}
    });
  `);
}

describe("chat with defined agents", () => {
  it("selects a file agent without provider credentials and retains only completed conversation", async () => {
    vi.stubEnv("OPENAI_API_KEY", undefined);
    const { directory } = await fixture();
    const io = {
      ...captureIo(directory),
      stdin: Readable.from(["first\nfail\nsecond\n/model\n/model other\nthird\n/clear\nfourth\n"]),
    };
    expect(await runWorkbenchCli(["agent", "pipeline.mjs", "--no-graph"], io)).toBe(0);
    const output = io.output.join("");
    expect(output).toContain("first:fresh");
    expect(output).toContain("second:first");
    expect(output).toContain("third:second");
    expect(output).toContain("fourth:fresh");
    expect(output).toContain("Model: configured by agent fixture-chat");
    expect(io.errors.join("")).toContain("fixture failed");
    expect(io.errors.join("")).toContain("Selected agents own their model");
  });

  it("runs the public chat recipe with delegated tools and records each prompt under its own agent ID", async () => {
    const { directory } = await writeModule("");
    const io = { ...captureIo(directory), stdin: Readable.from(["hello\nworld\n"]) };
    expect(
      await runWorkbenchCli(
        [
          "agent",
          resolve("examples/agent-chat.ts"),
          "--store",
          "runs.sqlite",
          "--trace",
          "runs.ndjson",
        ],
        io
      )
    ).toBe(0);
    expect(io.output.join("")).toContain("Previous prompt: hello");
    expect(io.output.join("")).toContain("WORLD");
    const events = (await readFile(join(directory, "runs.ndjson"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(
      events.some(
        (event) => event.name === "pipeline.started" && event.pipelineId === "scripted-agent"
      )
    ).toBe(true);
    for (const source of [
      ["--store", "runs.sqlite"],
      ["--trace", "runs.ndjson"],
    ]) {
      const history = captureIo(directory);
      expect(
        await runWorkbenchCli(["history", ...source, "--pipeline", "chat-agent", "--json"], history)
      ).toBe(0);
      const { runs } = JSON.parse(history.output.join(""));
      expect(runs).toHaveLength(2);
      expect(runs.every((run: { status: string }) => run.status === "completed")).toBe(true);
    }
    expect(io.errors).toEqual([]);
  });

  it.each([false, true])(
    "resolves project IDs with project cwd, per-prompt tracing and command adapters (wrapped=%s)",
    async (wrapped) => {
      const { directory, filePath } = await fixture();
      await mkdir(join(directory, "workspace"));
      const project = join(directory, "custom.project.mjs");
      await writeFile(
        project,
        `
      import { Chat } from ${JSON.stringify(pathToFileURL(filePath).href)};
      import { defineProject } from ${JSON.stringify(moduleUrl("project/project"))};
      import { definePipelineCommand } from ${JSON.stringify(moduleUrl("cli/cli"))};
      export const contexts = []; export const events = []; export let flushes = 0;
      const entry = ${wrapped ? 'definePipelineCommand(Chat, {params: {}, mapOptions: () => { throw new Error("chat must not call command mappings"); }})' : "Chat"};
      export default defineProject("chats", [entry], {cwd: "workspace", tracing: {exporters: context => {
        contexts.push(context); return [{export: event => events.push(event), flush: () => {flushes++;}}];
      }}});
    `
      );
      const io = { ...captureIo(directory), stdin: Readable.from(["first\nsecond\n"]) };
      expect(
        await runWorkbenchCli(["agent", "fixture-chat", "--project", "custom.project.mjs"], io)
      ).toBe(0);
      expect(io.output.join("")).toContain(`first:fresh:${join(directory, "workspace")}`);
      const exported = await import(pathToFileURL(project).href);
      expect(exported.contexts).toHaveLength(2);
      expect(exported.contexts[0]).toMatchObject({
        pipelineId: "fixture-chat",
        cwd: join(directory, "workspace"),
      });
      expect(exported.contexts[0].signal).not.toBe(exported.contexts[1].signal);
      expect(
        exported.events.some((event: { name: string }) => event.name === "pipeline.started")
      ).toBe(true);
      expect(exported.flushes).toBeGreaterThanOrEqual(2);
      expect(io.errors).toEqual([]);
    }
  );

  it("discovers the default project and supports named export selection in files", async () => {
    const { directory } = await fixture();
    await writeFile(join(directory, "tubeless.project.mjs"), "");
    await writeFile(
      join(directory, "tubeless.project.ts"),
      `
      import {Chat} from './pipeline.mjs';
      import {defineProject} from ${JSON.stringify(moduleUrl("project/project"))};
      export default defineProject("chats", [Chat]);
    `
    );
    const io = captureIo(directory);
    expect(await runWorkbenchCli(["agent", "fixture-chat", "--prompt", "hi"], io)).toBe(0);
    const named = captureIo(directory);
    expect(
      await runWorkbenchCli(
        ["agent", "pipeline.mjs", "--export", "Chat", "--prompt", "named"],
        named
      )
    ).toBe(0);
    expect(named.output.join("")).toContain("named:fresh");
  });

  it.each([
    "inputSchema: { '~standard': {version: 1, vendor: 'test', validate: value => ({value})} }, task: () => 'typed'",
    "resultSchema: { '~standard': {version: 1, vendor: 'test', validate: value => ({value})} }, resultJsonSchema: {type: 'object', properties: {answer: {type: 'string'}}, required: ['answer'], additionalProperties: false}",
  ])("rejects custom chat schemas before model execution", async (config) => {
    const { directory } = await fixture(config);
    const io = captureIo(directory);
    expect(await runWorkbenchCli(["agent", "pipeline.mjs", "--prompt", "hi"], io)).toBe(2);
    expect(io.errors.join("")).toContain("default { task } input and { answer } result");
    expect(io.output).toEqual([]);
  });

  it("rejects ordinary pipelines and defineAgentLoop agents clearly", async () => {
    for (const file of [resolve("examples/minimal-pipeline.ts"), resolve("examples/agent.ts")]) {
      const io = captureIo("/tmp");
      expect(await runWorkbenchCli(["agent", file, "--prompt", "hi"], io)).toBe(2);
      expect(io.errors.join("")).toContain("Use tubeless run");
    }
  });

  it("preserves a selected agent's environment", async () => {
    const { directory } = await fixture(
      "environment: () => {throw new Error('selected environment initialized');}"
    );
    const io = captureIo(directory);
    expect(await runWorkbenchCli(["agent", "pipeline.mjs", "--prompt", "hi"], io)).toBe(6);
    expect(io.errors.join("")).toContain("selected environment initialized");
  });

  it("cancels an active selected-agent prompt and continues from the previous conversation", async () => {
    const { directory, filePath } = await fixture();
    const { started } = await import(pathToFileURL(filePath).href);
    const stdin = new PassThrough();
    const io = { ...captureIo(directory), stdin };
    const onSpy = vi.spyOn(process, "on");
    try {
      const running = runWorkbenchCli(
        ["agent", "pipeline.mjs", "--trace", "runs.ndjson", "--no-graph"],
        io
      );
      stdin.write("seed\nwait\n");
      await started;
      const interrupt = onSpy.mock.calls.find(([name]) => name === "SIGINT")![1] as () => void;
      interrupt();
      stdin.end("after\n");
      expect(await running).toBe(0);
      expect(io.output.join("")).toContain("after:seed");
    } finally {
      onSpy.mockRestore();
      stdin.destroy();
    }
    const history = captureIo(directory);
    expect(
      await runWorkbenchCli(
        ["history", "--trace", "runs.ndjson", "--pipeline", "fixture-chat", "--json"],
        history
      )
    ).toBe(0);
    expect(
      JSON.parse(history.output.join(""))
        .runs.map((run: { status: string }) => run.status)
        .sort()
    ).toEqual(["cancelled", "completed", "completed"]);
  });

  it.each(["node", "bun"])(
    "loads and chats with a separately imported agent in the executable on %s",
    async (runtime) => {
      const { filePath } = await fixture();
      const { stdout, stderr } = await execFileAsync(
        runtime,
        ["dist/workbench/workbench-bin.js", "agent", filePath, "--prompt", "hi", "--no-graph"],
        { cwd: process.cwd() }
      );
      expect(stdout).toContain("hi:fresh");
      expect(stderr).toBe("");
    }
  );

  it.each([
    ["--model", "other"],
    ["--provider", "anthropic"],
    ["--model-module", "missing.mjs"],
    ["--env-file", "missing.env"],
    ["--instructions", "extra"],
    ["--tools", "read"],
    ["--codemode"],
    ["--max-turns", "2"],
    ["--max-calls", "2"],
    ["--max-concurrency", "2"],
  ])("rejects agent-definition overrides before loading modules: %j", async (...flags) => {
    const io = captureIo("/tmp");
    expect(await runWorkbenchCli(["agent", "missing.mjs", "--prompt", "hi", ...flags], io)).toBe(1);
    expect(io.errors.join("")).toContain("Selected agents own their configuration");
  });
});
