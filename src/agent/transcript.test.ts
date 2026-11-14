import { describe, expect, it, vi } from "vitest";
import { createSteps, definePipeline } from "../core/pipeline.js";
import { defer } from "../core/child-pipeline.test-support.js";
import {
  createAgentSession,
  createMemoryAgentCheckpointStore,
  defineAgent,
  defineAgentLoop,
  defineTool,
  pipelineTool,
  ToolError,
  type AgentTranscriptEvent,
  type AgentTranscriptOptions,
  type AgentTranscriptRecord,
} from "./agent.js";
import { emptyInput, numberSchema, schema } from "./agent.test-support.js";
import { agentTranscript } from "./transcript.js";

const base = {
  id: "transcript-test",
  inputSchema: emptyInput,
  resultSchema: numberSchema,
  defaultTools: [] as const,
  initialState: () => 0,
};
const finish = { kind: "finish", result: 4 };
const batch = {
  kind: "continue",
  calls: [{ id: "one", tool: "double", input: 2 }],
};
const double = defineTool({
  description: "Double a number",
  inputSchema: numberSchema,
  outputSchema: numberSchema,
  run: (value) => value * 2,
  dryRun: (value) => value * 2,
});
const events = (records: AgentTranscriptRecord[]): AgentTranscriptEvent[] =>
  records.flatMap((record) => ("event" in record ? [record.event] : []));
const collect = (records: AgentTranscriptRecord[]): AgentTranscriptOptions => ({
  write: (record) => {
    records.push(record);
  },
});

describe("agent transcript capture", () => {
  it("snapshots queued content when observed, before a slow sink finishes", async () => {
    const records: AgentTranscriptRecord[] = [];
    const entered = defer();
    const release = defer();
    await defineAgentLoop({
      ...base,
      transcript: {
        write: async (record) => {
          if ("event" in record && record.event.kind === "assistant") {
            entered.resolve();
            await release.promise;
          }
          records.push(record);
        },
      },
      decide: async (_state, context) => {
        const capture = agentTranscript(context)!;
        const first = capture.record(context.turn, { kind: "assistant", text: "queued" });
        await entered.promise;
        const decision = { kind: "finish", result: 4 };
        const second = capture.record(context.turn, { kind: "decision", decision });
        decision.result = 5;
        release.resolve();
        await Promise.all([first, second]);
        return finish;
      },
    }).runOrThrow();
    expect(events(records)[1]).toEqual({
      kind: "decision",
      decision: { kind: "finish", result: 4 },
    });
  });

  it("keeps capture out of traces and definition identity, and does no copying when off", async () => {
    const result = Object.defineProperty({}, "private", {
      get: () => {
        throw new Error("Do not inspect");
      },
    });
    const resultSchema = schema<object>(() => ({ value: result }));
    const config = { ...base, resultSchema, decide: () => ({ kind: "finish", result }) };
    const plain = defineAgentLoop(config);
    expect(await plain.runOrThrow()).toBe(result);
    const records: AgentTranscriptRecord[] = [];
    const captured = defineAgentLoop({ ...config, transcript: collect(records) });
    expect(captured.definition.identity).toEqual(plain.definition.identity);
    const traces: unknown[] = [];
    await captured.runOrThrow({}, undefined, {
      tracing: {
        exporter: {
          export: (event) => {
            traces.push(event);
          },
        },
      },
    });
    expect(records[0]).toMatchObject({ omitted: "decision", reason: "unsupported-content" });
    expect(JSON.stringify(traces)).not.toContain("unsupported-content");
  });

  it("captures raw decisions and once-validated inputs/results, including expected errors", async () => {
    const records: AgentTranscriptRecord[] = [];
    const validateInput = vi.fn((value: unknown) => ({ value: Number(value) }));
    const validateOutput = vi.fn((value: unknown) => ({ value: { doubled: value } }));
    const tool = defineTool({
      description: "Transform arguments and results",
      inputSchema: schema<string, number>(validateInput),
      outputSchema: schema<number, { doubled: unknown }>(validateOutput),
      run: (value) => {
        if (value === 0) throw new ToolError("MISSING", "No value");
        return value * 2;
      },
    });
    await defineAgentLoop({
      ...base,
      tools: { tool },
      transcript: collect(records),
      decide: (_state, context) =>
        context.turn === 1
          ? {
              kind: "continue",
              calls: [
                { id: "ok", tool: "tool", input: "2" },
                { id: "missing", tool: "tool", input: "0" },
              ],
            }
          : finish,
    }).runOrThrow();
    expect(validateInput).toHaveBeenCalledTimes(2);
    expect(validateOutput).toHaveBeenCalledOnce();
    expect(events(records)).toEqual([
      {
        kind: "decision",
        decision: {
          kind: "continue",
          calls: [
            { id: "ok", tool: "tool", input: "2" },
            { id: "missing", tool: "tool", input: "0" },
          ],
        },
      },
      { kind: "call", id: "ok", tool: "tool", input: 2 },
      { kind: "outcome", outcome: { id: "ok", tool: "tool", ok: true, value: { doubled: 4 } } },
      { kind: "call", id: "missing", tool: "tool", input: 0 },
      {
        kind: "outcome",
        outcome: {
          id: "missing",
          tool: "tool",
          ok: false,
          error: { code: "MISSING", message: "No value" },
        },
      },
      { kind: "decision", decision: finish },
      { kind: "end", status: "completed" },
    ]);
    expect(records.map((record) => record.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(records.map((record) => record.turn)).toEqual([1, 1, 1, 1, 1, 2, 2]);
    expect(new Set(records.map((record) => record.runId)).size).toBe(1);
  });

  it("owns redaction inputs, supports suppression and never changes runtime data", async () => {
    const records: AgentTranscriptRecord[] = [];
    const decision = { kind: "finish", result: 4 };
    const redact = vi.fn((event: AgentTranscriptEvent): AgentTranscriptEvent | null => {
      expect(Object.isFrozen(event)).toBe(true);
      if (event.kind === "decision") {
        expect(Object.isFrozen(event.decision)).toBe(true);
        return { ...event, decision: "[redacted]" };
      }
      return null;
    });
    expect(
      await defineAgentLoop({
        ...base,
        decide: () => decision,
        transcript: { ...collect(records), redact },
      }).runOrThrow()
    ).toBe(4);
    expect(decision.result).toBe(4);
    expect(events(records)).toEqual([{ kind: "decision", decision: "[redacted]" }]);
    expect(redact).toHaveBeenCalledTimes(2);
  });

  it.each(["sink", "redactor"])(
    "isolates %s failures and emits no exception content",
    async (failure) => {
      const warn = vi.fn();
      const write = vi.fn(() => {
        if (failure === "sink") throw new Error("private-content");
      });
      const redact = vi.fn((event: AgentTranscriptEvent) => {
        if (failure === "redactor") throw new Error("private-content");
        return event;
      });
      expect(
        await defineAgentLoop({
          ...base,
          decide: () => finish,
          transcript: { write, redact },
        }).runOrThrow({}, undefined, { log: { log() {}, warn, error() {} } })
      ).toBe(4);
      expect(warn).toHaveBeenCalledOnce();
      expect(JSON.stringify(warn.mock.calls)).not.toContain("private-content");
      expect(redact).toHaveBeenCalledOnce();
      expect(write).toHaveBeenCalledTimes(failure === "sink" ? 1 : 0);
    }
  );

  it("bounds UTF-8 records before and after redaction and reserves a total-limit marker", async () => {
    const records: AgentTranscriptRecord[] = [];
    const redact = vi.fn((event: AgentTranscriptEvent) =>
      event.kind === "call" ? { ...event, input: "🙂".repeat(500) } : event
    );
    const agent = defineAgentLoop({
      ...base,
      tools: { double },
      limits: { maxTurns: 20 },
      transcript: { ...collect(records), redact, maxRecordBytes: 1024, maxBytes: 3072 },
      decide: (_state, context) => (context.turn < 10 ? batch : finish),
    });
    expect(await agent.runOrThrow()).toBe(4);
    expect(records.some((record) => "omitted" in record && record.omitted === "call")).toBe(true);
    expect(records.at(-1)).toMatchObject({ limit: "maxBytes" });
    const sizes = records.map((record) => Buffer.byteLength(JSON.stringify(record)) + 1);
    expect(sizes.every((size) => size <= 1024)).toBe(true);
    expect(sizes.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(3072);
    const oversized: AgentTranscriptRecord[] = [];
    await defineAgent({
      id: "oversized",
      projectContext: false,
      defaultTools: [],
      instructions: "🙂".repeat(500),
      transcript: { ...collect(oversized), maxRecordBytes: 1024, maxBytes: 4096 },
      model: () => ({
        decision: { kind: "finish", result: { answer: "done" } },
        conversation: null,
      }),
    }).runOrThrow({ task: "task" });
    expect(oversized[0]).toMatchObject({ omitted: "prompt", reason: "record-limit" });
  });

  it.each([
    () => undefined,
    () => NaN,
    () => new Date(),
    () => ({
      get secret() {
        throw new Error("getter invoked");
      },
    }),
    () => {
      const cyclic: unknown[] = [];
      cyclic.push(cyclic);
      return cyclic;
    },
  ])("omits unsupported content without failing a valid result: %s", async (makeValue) => {
    const value = makeValue();
    const records: AgentTranscriptRecord[] = [];
    const redact = vi.fn((event: AgentTranscriptEvent) => event);
    await defineAgentLoop({
      ...base,
      resultSchema: schema(() => ({ value })),
      decide: () => ({ kind: "finish", result: value }),
      transcript: { ...collect(records), redact },
    }).runOrThrow();
    expect(records[0]).toMatchObject({ omitted: "decision", reason: "unsupported-content" });
    expect(redact).toHaveBeenCalledOnce(); // Only the end event is passed through.
  });

  it("records invalid proposals and fatal termination without leaking exceptions", async () => {
    const records: AgentTranscriptRecord[] = [];
    const run = await defineAgentLoop({
      ...base,
      decide: () => ({ kind: "invalid" }),
      transcript: collect(records),
    }).run();
    expect(run.status).toBe("failed");
    expect(events(records)).toEqual([
      { kind: "decision", decision: { kind: "invalid" } },
      { kind: "end", status: "failed" },
    ]);
  });

  it("serializes concurrent tool completion and isolates simultaneous run sequences", async () => {
    const records: AgentTranscriptRecord[] = [];
    let active = 0;
    const slow = defer();
    const fastDone = defer();
    const tool = defineTool({
      description: "Ordered completion",
      inputSchema: numberSchema,
      outputSchema: numberSchema,
      run: async (value) => {
        if (value === 1) await slow.promise;
        else fastDone.resolve();
        return value;
      },
    });
    const agent = defineAgentLoop({
      ...base,
      tools: { tool },
      limits: { maxConcurrency: 2 },
      transcript: {
        write: async (record) => {
          expect(++active).toBe(1);
          await Promise.resolve();
          records.push(record);
          active--;
        },
      },
      decide: (_state, context) =>
        context.turn === 1
          ? {
              kind: "continue",
              calls: [
                { id: "slow", tool: "tool", input: 1 },
                { id: "fast", tool: "tool", input: 2 },
              ],
            }
          : finish,
    });
    const run = agent.runOrThrow();
    await fastDone.promise;
    await vi.waitFor(() =>
      expect(events(records).some((event) => event.kind === "outcome")).toBe(true)
    );
    slow.resolve();
    await run;
    expect(
      events(records)
        .filter((event) => event.kind === "outcome")
        .map((event) => event.outcome.id)
    ).toEqual(["fast", "slow"]);
    const other: AgentTranscriptRecord[] = [];
    const isolated = defineAgentLoop({ ...base, decide: () => finish, transcript: collect(other) });
    await Promise.all([isolated.runOrThrow(), isolated.runOrThrow()]);
    const ids = new Set(other.map((record) => record.runId));
    expect(ids.size).toBe(2);
    for (const id of ids)
      expect(
        other.filter((record) => record.runId === id).map((record) => record.sequence)
      ).toEqual([1, 2]);
  });

  it("drains successful siblings before fatal or cancelled termination", async () => {
    for (const cancelled of [false, true]) {
      const records: AgentTranscriptRecord[] = [];
      const controller = new AbortController();
      const started = defer();
      const released = defer();
      const tool = defineTool({
        description: "Drain work",
        inputSchema: numberSchema,
        outputSchema: numberSchema,
        run: async (value) => {
          if (value === 1) {
            await started.promise;
            if (cancelled) controller.abort();
            else {
              released.resolve();
              throw new Error("private failure");
            }
            released.resolve();
            return value;
          }
          started.resolve();
          await released.promise;
          return value;
        },
      });
      const run = await defineAgentLoop({
        ...base,
        tools: { tool },
        limits: { maxConcurrency: 2 },
        transcript: collect(records),
        decide: () => ({
          kind: "continue",
          calls: [
            { id: "first", tool: "tool", input: 1 },
            { id: "sibling", tool: "tool", input: 2 },
          ],
        }),
      }).run({}, undefined, { signal: controller.signal });
      expect(run.status).toBe(cancelled ? "cancelled" : "failed");
      expect(events(records).at(-1)).toEqual({
        kind: "end",
        status: cancelled ? "cancelled" : "failed",
      });
      if (!cancelled)
        expect(
          events(records).some(
            (event) => event.kind === "outcome" && event.outcome.id === "sibling"
          )
        ).toBe(true);
      expect(JSON.stringify(records)).not.toContain("private failure");
    }
  });

  it("requires nested agent opt-in while retaining ordinary pipeline calls", async () => {
    const parentRecords: AgentTranscriptRecord[] = [];
    const childRecords: AgentTranscriptRecord[] = [];
    for (const captureChild of [false, true]) {
      parentRecords.length = 0;
      childRecords.length = 0;
      const child = defineAgentLoop({
        ...base,
        id: "child-agent",
        decide: () => finish,
        transcript: captureChild ? collect(childRecords) : undefined,
      });
      const wrapped = createSteps<{}>().fromPipeline("wrapped", { pipeline: child });
      const pipeline = definePipeline({ id: "bridge", steps: [wrapped], finalize: wrapped });
      await defineAgentLoop({
        ...base,
        tools: {
          child: pipelineTool(pipeline, {
            description: "Delegate through a pipeline",
            inputSchema: emptyInput,
            mapOptions: () => ({}),
          }),
        },
        transcript: collect(parentRecords),
        decide: (_state, context) =>
          context.turn === 1
            ? { kind: "continue", calls: [{ id: "delegate", tool: "child", input: {} }] }
            : finish,
      }).runOrThrow();
      expect(parentRecords.every((record) => record.agentId === base.id)).toBe(true);
      expect(events(parentRecords).filter((event) => event.kind === "decision")).toHaveLength(2);
      expect(childRecords).toHaveLength(captureChild ? 2 : 0);
      if (captureChild)
        expect(childRecords[0]).toMatchObject({
          agentId: "child-agent",
          parentRunId: expect.any(String),
        });
    }
  });

  it("captures nested code-mode calls", async () => {
    const records: AgentTranscriptRecord[] = [];
    await defineAgentLoop({
      ...base,
      codemode: true,
      tools: { double },
      transcript: collect(records),
      decide: (_state, context) =>
        context.turn === 1
          ? {
              kind: "continue",
              calls: [
                {
                  id: "script",
                  tool: "codemode",
                  input: { code: "return await tools.double(2);" },
                },
              ],
            }
          : finish,
    }).runOrThrow();
    expect(
      events(records)
        .filter((event) => event.kind === "outcome")
        .map((event) => event.outcome.tool)
    ).toEqual(["double", "codemode"]);
  });

  it("captures previews only when explicitly executed, and does nothing during planning", async () => {
    const records: AgentTranscriptRecord[] = [];
    const config = { ...base, decide: () => finish, transcript: collect(records) };
    const skipped = defineAgentLoop(config);
    skipped.plan();
    await skipped.run({}, { dryRun: true });
    expect(records).toEqual([]);
    await defineAgentLoop({ ...config, dryRun: () => finish }).runOrThrow({}, { dryRun: true });
    expect(records).toHaveLength(2);
    expect(records.every((record) => record.dryRun)).toBe(true);
  });

  it("snapshots session capture configuration and marks completed durable replay without duplicating turns", async () => {
    const records: AgentTranscriptRecord[] = [];
    const write = vi.fn((record: AgentTranscriptRecord) => {
      records.push(record);
    });
    const transcript: { write: AgentTranscriptOptions["write"] } = {
      write,
    };
    const model = vi.fn(() => ({
      decision: { kind: "finish", result: { answer: "done" } },
      conversation: [],
    }));
    const agent = defineAgent({
      id: "session",
      projectContext: false,
      defaultTools: [],
      model,
      transcript,
      implementationVersion: "v1",
      durability: { store: createMemoryAgentCheckpointStore(), key: "test" },
    });
    transcript.write = () => {
      throw new Error("configuration mutated");
    };
    const session = createAgentSession(agent);
    await session.runOrThrow({ task: "hello" });
    const count = records.length;
    await session.runOrThrow({ task: "hello" });
    expect(model).toHaveBeenCalledOnce();
    expect(events(records.slice(count))).toEqual([
      { kind: "end", status: "completed", replayed: true },
    ]);
    expect(records[count]!.runId).not.toBe(records[0]!.runId);
  });

  it("marks restored outcomes without repeating their handlers or inventing a past decision", async () => {
    const records: AgentTranscriptRecord[] = [];
    const controller = new AbortController();
    let interrupt = true;
    const work = vi.fn((value: number) => value * 2);
    const agent = defineAgentLoop({
      ...base,
      implementationVersion: "v1",
      durability: { store: createMemoryAgentCheckpointStore(), key: "resume" },
      transcript: collect(records),
      tools: {
        double: defineTool({
          description: "Work once",
          inputSchema: numberSchema,
          outputSchema: numberSchema,
          run: work,
        }),
      },
      decide: (_state, context) => (context.turn === 1 ? batch : finish),
      reduce: () => {
        if (interrupt) {
          interrupt = false;
          controller.abort();
        }
        return 4;
      },
    });
    expect((await agent.run({}, undefined, { signal: controller.signal })).status).toBe(
      "cancelled"
    );
    records.length = 0;
    expect(await agent.runOrThrow()).toBe(4);
    expect(work).toHaveBeenCalledOnce();
    expect(events(records)).toEqual([
      {
        kind: "outcome",
        outcome: { id: "one", tool: "double", ok: true, value: 4 },
        replayed: true,
      },
      { kind: "decision", decision: finish },
      { kind: "end", status: "completed" },
    ]);
  });

  it.each([
    { maxRecordBytes: 0 },
    { maxRecordBytes: 65537 },
    { maxBytes: 1 },
    { maxBytes: Infinity },
    { write: null },
    { redact: 42 },
  ])("rejects invalid capture configuration at definition: %j", (options) => {
    expect(() =>
      defineAgentLoop({
        ...base,
        decide: () => finish,
        transcript: { write() {}, ...options } as AgentTranscriptOptions,
      })
    ).toThrow("Invalid agent transcript");
  });
});
