import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { createPipelineTestRuntime } from "tubeless/testing";
import type { PipelineTraceEvent } from "tubeless/tracing";
import { OpenAIAgent } from "../../examples/agent-openai.js";

const fetchMock = vi.fn<typeof fetch>();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("OPENAI_API_KEY", "test-key-never-record");
  vi.stubEnv("OPENAI_MODEL", undefined);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function call(name: string, args: unknown, callId = name) {
  return { type: "function_call", name, arguments: JSON.stringify(args), call_id: callId };
}
function completed(...output: unknown[]) {
  return { status: "completed", output };
}
function respond(...output: unknown[]) {
  fetchMock.mockResolvedValueOnce(Response.json(completed(...output)));
}
function request(index: number) {
  return JSON.parse(String(fetchMock.mock.calls[index]![1]!.body));
}
function recording() {
  const events: PipelineTraceEvent[] = [];
  return {
    events,
    tracing: {
      exporter: {
        export: (event: PipelineTraceEvent) => {
          events.push(event);
        },
      },
    },
  };
}

describe("OpenAI agent recipe", () => {
  it("runs model-selected batches, supplies accumulated outcomes, and validates the final answer", async () => {
    vi.stubEnv("OPENAI_MODEL", "example-model");
    respond(
      call("uppercase", { input: "red" }, "red"),
      call("uppercase", { input: "blue" }, "blue")
    );
    respond(call("count", { input: "RED BLUE" }, "count"));
    respond(
      { type: "reasoning", summary: [] },
      call("_finish", { result: "RED BLUE: 8 characters" })
    );
    const { events, tracing } = recording();
    const question = "Uppercase red and blue, then count the joined result.";
    const result = await OpenAIAgent.runOrThrow({ question }, undefined, {
      ...createPipelineTestRuntime().context,
      tracing,
    });
    expectTypeOf(result).toEqualTypeOf<{ answer: string }>();
    expect(result).toEqual({ answer: "RED BLUE: 8 characters" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0]![0]).toBe("https://api.openai.com/v1/responses");
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({
      method: "POST",
      headers: { Authorization: "Bearer test-key-never-record" },
      signal: expect.any(AbortSignal),
    });
    expect(request(0)).toMatchObject({
      model: "example-model",
      store: false,
      max_output_tokens: 2048,
      tool_choice: "required",
      parallel_tool_calls: true,
      tools: [
        { name: "count", strict: true, parameters: { properties: { input: { type: "string" } } } },
        { name: "uppercase", strict: true },
        {
          name: "_finish",
          strict: true,
          parameters: { properties: { result: { type: "string" } } },
        },
      ],
    });
    expect(JSON.parse(request(0).input)).toEqual({
      state: { question, observations: [] },
      turn: 1,
    });
    expect(JSON.parse(request(1).input).state.observations).toEqual([
      { id: "red", tool: "uppercase", ok: true, value: "RED" },
      { id: "blue", tool: "uppercase", ok: true, value: "BLUE" },
    ]);
    expect(JSON.parse(request(2).input).state.observations).toEqual([
      ...JSON.parse(request(1).input).state.observations,
      { id: "count", tool: "count", ok: true, value: 8 },
    ]);
    const starts = events.filter((event) => event.name === "pipeline.started");
    expect(starts.filter((event) => event.pipelineId === "openai-agent/turn")).toHaveLength(3);
    expect(
      starts.filter((event) => event.pipelineId.includes("/tool/")).map((event) => event.itemKey)
    ).toEqual(["red", "blue", "count"]);
    expect(JSON.stringify(events)).not.toContain("test-key-never-record");
    expect(JSON.stringify(events)).not.toContain(question);
  });

  it("feeds recoverable tool failures back to the model", async () => {
    respond(call("uppercase", { input: "missing" }));
    respond(call("_finish", { result: "The word is unavailable." }));
    expect(await createPipelineTestRuntime().runOrThrow(OpenAIAgent, {})).toEqual({
      answer: "The word is unavailable.",
    });
    expect(JSON.parse(request(1).input).state.observations).toEqual([
      {
        id: "uppercase",
        tool: "uppercase",
        ok: false,
        error: { code: "NOT_FOUND", message: "Word unavailable" },
      },
    ]);
  });

  it.each([
    null,
    { status: "incomplete", output: [call("uppercase", { input: "red" })] },
    completed(),
    completed({ type: "message", content: [{ type: "refusal", refusal: "No." }] }),
    completed({ type: "function_call" }),
    completed({ ...call("uppercase", { input: "red" }), arguments: "invalid JSON" }),
    completed(call("uppercase", {})),
    completed(call("uppercase", { input: "red", extra: true })),
    completed(call("uppercase", { input: "red" }), call("count", { input: 42 })),
    completed(call("unknown", { input: "red" })),
    completed(call("uppercase", { input: "red" }, "same"), call("count", { input: "red" }, "same")),
    completed(call("_finish", { result: "done" }), call("uppercase", { input: "red" })),
    completed(call("_finish", { result: 42 })),
    completed(
      ...Array.from({ length: 13 }, (_, i) => call("uppercase", { input: "red" }, String(i)))
    ),
  ])(
    "rejects invalid or inadmissible provider decisions before tool dispatch: %j",
    async (body) => {
      fetchMock.mockResolvedValueOnce(Response.json(body));
      const { events, tracing } = recording();
      const run = await OpenAIAgent.run({}, undefined, {
        ...createPipelineTestRuntime().context,
        tracing,
      });
      expect(run.status).toBe("failed");
      expect(run.finalized).toBe(false);
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(events.filter((event) => event.pipelineId.includes("/tool/"))).toEqual([]);
    }
  );

  it.each([401, 429, 500])(
    "fails HTTP %s without retries or recording the provider body",
    async (status) => {
      fetchMock.mockResolvedValueOnce(new Response("sensitive-provider-body", { status }));
      const run = await createPipelineTestRuntime().run(OpenAIAgent, {});
      expect(run.status).toBe("failed");
      expect(JSON.stringify(run.errors)).toContain(`HTTP ${status}`);
      expect(JSON.stringify(run)).not.toContain("sensitive-provider-body");
      expect(fetchMock).toHaveBeenCalledOnce();
    }
  );

  it("does not record malformed response bodies", async () => {
    fetchMock.mockResolvedValueOnce(new Response("sensitive-provider-body"));
    const run = await createPipelineTestRuntime().run(OpenAIAgent, {});
    expect(JSON.stringify(run.errors)).toContain("OpenAI returned invalid JSON");
    expect(JSON.stringify(run)).not.toContain("sensitive-provider-body");
  });

  it("requires credentials only during execution; plans and dry runs never request a model", async () => {
    vi.stubEnv("OPENAI_API_KEY", undefined);
    expect(OpenAIAgent.plan().ok).toBe(true);
    OpenAIAgent.toMermaid();
    const runtime = createPipelineTestRuntime();
    const preview = await runtime.run(OpenAIAgent, {}, { dryRun: true });
    expect(preview.steps[0]!.status).toBe("skipped");
    expect(preview.finalized).toBe(false);
    const run = await runtime.run(OpenAIAgent, {});
    expect(JSON.stringify(run.errors)).toContain("OPENAI_API_KEY is required");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("cancels an in-flight request without another model request or tool dispatch", async () => {
    const runtime = createPipelineTestRuntime();
    fetchMock.mockImplementationOnce(async (_url, init) => {
      const signal = init!.signal!;
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        runtime.abort();
      });
    });
    const { events, tracing } = recording();
    const run = await OpenAIAgent.run({}, undefined, { ...runtime.context, tracing });
    expect(run.status).toBe("cancelled");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(events.filter((event) => event.pipelineId.includes("/tool/"))).toEqual([]);
  });

  it("keeps simultaneous model runs' state separate", async () => {
    fetchMock.mockImplementation(async (_url, init) => {
      const { state } = JSON.parse(JSON.parse(String(init!.body)).input);
      return Response.json(
        completed(
          state.observations.length === 0
            ? call("count", { input: state.question })
            : call("_finish", { result: String(state.observations[0].value) })
        )
      );
    });
    expect(
      await Promise.all([
        createPipelineTestRuntime().runOrThrow(OpenAIAgent, { question: "ab" }),
        createPipelineTestRuntime().runOrThrow(OpenAIAgent, { question: "abcd" }),
      ])
    ).toEqual([{ answer: "2" }, { answer: "4" }]);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});
