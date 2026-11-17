import { expect, it, vi } from "vitest";
import { createSteps, definePipeline, type PipelineExecutionJournal } from "../core/pipeline.js";
import { retainedJournal } from "../core/execution-journal.test-support.js";
import {
  createAgentSession,
  createMemoryAgentCheckpointStore,
  defineAgent,
  defineAgentLoop,
  defineTool,
  pipelineTool,
  ToolError,
  type AgentCheckpointStore,
  type AgentTranscriptRecord,
} from "./agent.js";
import { emptyInput, numberSchema } from "./agent.test-support.js";
import { remote } from "./environment.test-support.js";

const context = (executionJournal: PipelineExecutionJournal, signal?: AbortSignal) => ({
  executionJournal,
  signal,
  log: { log() {}, warn() {}, error() {} },
});

it("hands completed native replay to a recreated session, preserving conversation and transcript capture", async () => {
  const records = new Map<string, Buffer>();
  const store = createMemoryAgentCheckpointStore();
  const transcript: AgentTranscriptRecord[] = [];
  const model = vi.fn((request) => ({
    decision: { kind: "finish", result: { answer: request.task } },
    conversation: [request.task],
  }));
  function agent() {
    return defineAgent({
      id: "host-chat",
      implementationVersion: "1",
      defaultTools: [],
      environment: remote(),
      projectContext: false,
      model,
      transcript: {
        write: (record) => {
          transcript.push(record);
        },
      },
    });
  }
  const host = () => ({ ...retainedJournal(records), agentStore: store });
  const first = createAgentSession(agent());
  expect(await first.runOrThrow({ task: "first" }, {}, context(host()))).toEqual({
    answer: "first",
  });
  transcript.length = 0;
  const replay = createAgentSession(agent());
  expect(await replay.runOrThrow({ task: "first" }, {}, context(host()))).toEqual({
    answer: "first",
  });
  expect(replay.conversation).toEqual(["first"]);
  expect(model).toHaveBeenCalledTimes(1);
  expect(transcript.flatMap((record) => ("event" in record ? [record.event] : []))).toEqual([
    { kind: "end", status: "completed", replayed: true },
  ]);
});

it("uses bounded, distinct native keys for long host and fan-out identities across recreation", async () => {
  const records = new Map<string, Buffer>();
  const store = createMemoryAgentCheckpointStore();
  const acquire = vi.fn(store.acquire.bind(store));
  const decide = vi.fn(() => ({ kind: "finish", result: 7 }));
  const longKey = "host".repeat(1500);
  const items = ["item".repeat(1500) + "a", "item".repeat(1500) + "b"];
  function pipeline() {
    const agent = defineAgentLoop({
      id: "long-identity",
      implementationVersion: "1",
      defaultTools: [],
      environment: remote(),
      inputSchema: emptyInput,
      resultSchema: numberSchema,
      initialState: () => 0,
      decide,
    });
    const { forEachPipeline } = createSteps();
    return definePipeline({
      id: "long-fan-out",
      implementationVersion: "1",
      steps: [
        forEachPipeline("agents", {
          pipeline: agent,
          items: () => items,
          key: (item) => item,
          mapOptions: () => ({}),
        }),
      ],
    });
  }
  const host = () => ({ ...retainedJournal(records, longKey), agentStore: { acquire } });
  const firstHost = host();
  const first = await pipeline().run(
    {},
    {},
    context({
      ...firstHost,
      complete: async (path, value) => {
        if (path.at(-1) === "agents")
          throw Object.assign(new Error("lost wrapper completion"), {
            code: "HOST_LOST_COMPLETION",
          });
        await firstHost.complete(path, value);
      },
    })
  );
  expect(first.errors[0]?.sourceCode).toBe("HOST_LOST_COMPLETION");
  expect(await pipeline().runOrThrow({}, {}, context(host()))).toEqual([7, 7]);
  expect(decide).toHaveBeenCalledTimes(2);
  const keys = acquire.mock.calls.map(([key]) => key);
  expect(keys).toHaveLength(4);
  expect(keys.every((key) => key.length > 0 && key.length <= 4096)).toBe(true);
  expect(keys[0]).toBe(keys[2]);
  expect(keys[1]).toBe(keys[3]);
  expect(keys[0]).not.toBe(keys[1]);
});

it("inherits one native journal through delegated agents and ordinary pipeline tools, suppressing the outer journal", async () => {
  const records = new Map<string, Buffer>();
  const bytes = createMemoryAgentCheckpointStore();
  const acquire = vi.fn(bytes.acquire.bind(bytes));
  const ignoredStore = {
    acquire: vi.fn(async () => {
      throw new Error("inherited journal must win");
    }),
  };
  const abort = new AbortController();
  let answered = false;
  const effect = vi.fn((_inputs, ctx) => {
    expect(ctx.executionJournal).toBeUndefined();
    expect(ctx.executionJournalPath).toBeUndefined();
    return 3;
  });
  function agent() {
    const { step } = createSteps();
    const tool = definePipeline({ id: "ordinary-tool", steps: [step("effect", { run: effect })] });
    const child = defineAgentLoop({
      id: "delegate",
      implementationVersion: "1",
      defaultTools: [],
      inputSchema: emptyInput,
      resultSchema: numberSchema,
      durability: { store: ignoredStore, key: "ignored" },
      initialState: () => 0,
      tools: {
        work: pipelineTool(tool, {
          description: "Work",
          inputSchema: emptyInput,
          mapOptions: () => ({}),
        }),
        ask: defineTool({
          description: "Ask",
          inputSchema: numberSchema,
          outputSchema: numberSchema,
          replay: "safe",
          run: (value) => {
            if (!answered) {
              abort.abort();
              throw abort.signal.reason;
            }
            return value;
          },
        }),
      },
      decide: (state, ctx) =>
        ctx.turn === 1
          ? {
              kind: "continue",
              calls: [
                { id: "work", tool: "work", input: {} },
                { id: "ask", tool: "ask", input: 4 },
              ],
            }
          : { kind: "finish", result: state },
      reduce: (_state, outcomes) =>
        outcomes.reduce((sum, item) => sum + (item.ok ? Number(item.value) : 0), 0),
    });
    return defineAgentLoop({
      id: "parent",
      implementationVersion: "1",
      defaultTools: [],
      environment: remote(),
      inputSchema: emptyInput,
      resultSchema: numberSchema,
      initialState: () => 0,
      tools: { child: pipelineTool(child, { description: "Delegate" }) },
      decide: (state, ctx) =>
        ctx.turn === 1
          ? { kind: "continue", calls: [{ id: "child", tool: "child", input: {} }] }
          : { kind: "finish", result: state },
      reduce: (_state, outcomes) => (outcomes[0].ok ? Number(outcomes[0].value) : -1),
    });
  }
  const host = () => ({ ...retainedJournal(records), agentStore: { acquire } });
  expect((await agent().run({}, {}, context(host(), abort.signal))).status).toBe("cancelled");
  answered = true;
  expect(await agent().runOrThrow({}, {}, context(host()))).toBe(7);
  expect(effect).toHaveBeenCalledTimes(1);
  expect(acquire).toHaveBeenCalledTimes(2);
  expect(ignoredStore.acquire).not.toHaveBeenCalled();
  // Native agent work never creates outer step receipts.
  expect([...records.keys()].filter((key) => key.startsWith('["step"'))).toEqual([]);
});

it("recovers input reader ToolErrors through pipeline tools with native journal handoff", async () => {
  const records = new Map<string, Buffer>();
  const store = createMemoryAgentCheckpointStore();
  const read = vi.fn(async () => {
    throw new ToolError("INPUT_UNAVAILABLE", "Input is unavailable");
  });
  const { waitForInput } = createSteps(emptyInput);
  const input = waitForInput("input", { read });
  const child = definePipeline({ id: "input-tool", steps: [input], finalize: input });
  const reduce = vi.fn((_state, outcomes) => {
    expect(outcomes).toEqual([
      {
        id: "read",
        tool: "input",
        ok: false,
        error: { code: "INPUT_UNAVAILABLE", message: "Input is unavailable" },
      },
    ]);
    return 1;
  });
  function agent() {
    return defineAgentLoop({
      id: "input-recovery",
      implementationVersion: "1",
      defaultTools: [],
      environment: remote(),
      inputSchema: emptyInput,
      resultSchema: numberSchema,
      initialState: () => 0,
      tools: { input: pipelineTool(child, { description: "Read input" }) },
      decide: (state, ctx) =>
        ctx.turn === 1
          ? { kind: "continue", calls: [{ id: "read", tool: "input", input: {} }] }
          : { kind: "finish", result: state },
      reduce,
    });
  }
  const host = () => ({ ...retainedJournal(records), agentStore: store });
  expect(await agent().runOrThrow({}, {}, context(host()))).toBe(1);
  expect(await agent().runOrThrow({}, {}, context(host()))).toBe(1);
  expect(read).toHaveBeenCalledOnce();
  expect(reduce).toHaveBeenCalledOnce();
});

it("prefers explicit root durability over host handoff", async () => {
  const acquire = vi.fn();
  const agent = defineAgentLoop({
    id: "explicit",
    implementationVersion: "1",
    defaultTools: [],
    environment: remote(),
    inputSchema: emptyInput,
    resultSchema: numberSchema,
    durability: { store: createMemoryAgentCheckpointStore(), key: "explicit" },
    initialState: () => 0,
    decide: () => ({ kind: "finish", result: 1 }),
  });
  expect(
    await agent.runOrThrow({}, {}, context({ ...retainedJournal(), agentStore: { acquire } }))
  ).toBe(1);
  expect(acquire).not.toHaveBeenCalled();
});

it.each(["missing", "acquire", "read", "write", "close"])(
  "propagates native %s handoff failure",
  async (failure) => {
    const decide = vi.fn(() => ({ kind: "finish", result: 1 }));
    const problem = Object.assign(new Error("native storage unavailable"), { code: "HOST_NATIVE" });
    const store: AgentCheckpointStore = {
      acquire: async () => {
        if (failure === "acquire") throw problem;
        return {
          read: async () => {
            if (failure === "read") throw problem;
            return undefined;
          },
          write: async () => {
            if (failure === "write") throw problem;
          },
          close: async () => {
            if (failure === "close") throw problem;
          },
        };
      },
    };
    const agent = defineAgentLoop({
      id: "failure",
      implementationVersion: "1",
      defaultTools: [],
      environment: remote(),
      inputSchema: emptyInput,
      resultSchema: numberSchema,
      initialState: () => 0,
      decide,
    });
    const result = await agent.run(
      {},
      { continueOnError: true },
      context({ ...retainedJournal(), ...(failure === "missing" ? {} : { agentStore: store }) })
    );
    expect(result.status).toBe("failed");
    expect(result.errors[0]?.sourceCode).toBe(
      failure === "missing" ? "TUBELESS_JOURNAL_AGENT_STORE_REQUIRED" : "HOST_NATIVE"
    );
    if (failure !== "close") expect(decide).not.toHaveBeenCalled();
  }
);

it("keeps inherited implementation-version checks and host checkpoint I/O out of dry runs", async () => {
  const store = createMemoryAgentCheckpointStore();
  const acquire = vi.fn(store.acquire.bind(store));
  const child = defineAgentLoop({
    id: "unversioned",
    defaultTools: [],
    inputSchema: emptyInput,
    resultSchema: numberSchema,
    initialState: () => 0,
    decide: () => ({ kind: "finish", result: 1 }),
  });
  const agent = defineAgentLoop({
    id: "versioned",
    implementationVersion: "1",
    defaultTools: [],
    environment: remote(),
    inputSchema: emptyInput,
    resultSchema: numberSchema,
    initialState: () => 0,
    dryRun: () => ({ kind: "finish", result: 0 }),
    tools: { child: pipelineTool(child, { description: "Delegate" }) },
    decide: () => ({ kind: "continue", calls: [{ id: "one", tool: "child", input: {} }] }),
  });
  const result = await agent.run(
    {},
    {},
    context({ ...retainedJournal(), agentStore: { acquire } })
  );
  expect(result.status).toBe("failed");
  expect(JSON.stringify(result.errors)).toContain("implementationVersion");
  acquire.mockClear();
  const preview = await agent.run(
    {},
    { dryRun: true },
    context({ ...retainedJournal(), agentStore: { acquire } })
  );
  expect(preview.status).toBe("completed");
  expect(acquire).not.toHaveBeenCalled();
});
