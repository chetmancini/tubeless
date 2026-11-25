import type { LanguageModel } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import { createAgentSession, defineAgent, defineTool, type AgentModel } from "./agent.js";
import { textSchema } from "./agent.test-support.js";
import { aiSdkModel, type AiSdkLanguageModel, type AiSdkModelOptions } from "./ai-sdk.js";

type GenerateResult = Awaited<ReturnType<MockLanguageModelV3["doGenerate"]>>;

const usage = {
  inputTokens: { total: 20, noCache: 15, cacheRead: 4, cacheWrite: 1 },
  outputTokens: { total: 6, text: 5, reasoning: 1 },
};

const toolCall = (
  toolName: string,
  input: unknown,
  toolCallId = toolName
): GenerateResult["content"][number] => ({
  type: "tool-call",
  toolCallId,
  toolName,
  input: JSON.stringify(input),
});

const generated = (
  content: GenerateResult["content"],
  finishReason: GenerateResult["finishReason"]["unified"] = "tool-calls"
): GenerateResult => ({
  content,
  finishReason: { unified: finishReason, raw: finishReason },
  usage,
  warnings: [],
});

const finish = (answer = "Done.") =>
  generated([toolCall("_finish", { result: { answer } }, "finish")]);

function mockModel(
  doGenerate:
    | GenerateResult
    | GenerateResult[]
    | NonNullable<ConstructorParameters<typeof MockLanguageModelV3>[0]>["doGenerate"]
) {
  return new MockLanguageModelV3({ provider: "mock", modelId: "mock-model", doGenerate });
}

const agent = (model: AgentModel, id: string) =>
  defineAgent({ id, projectContext: false, defaultTools: [], model });

describe("AI SDK model", () => {
  it("accepts an AI SDK language model and returns its structured answer", async () => {
    const model = mockModel(finish());
    const typed: LanguageModel = model;
    const transcript: unknown[] = [];
    expect(
      await defineAgent({
        id: "structured",
        projectContext: false,
        defaultTools: [],
        transcript: {
          write(record) {
            transcript.push(record);
          },
        },
        model: aiSdkModel({ model: typed, maxRetries: 0, reasoningEffort: "low" }),
      }).runOrThrow({ task: "Finish" })
    ).toEqual({ answer: "Done." });
    expect(model.doGenerateCalls).toHaveLength(1);
    expect(model.doGenerateCalls[0]).toMatchObject({ reasoning: "low" });
    expect(JSON.stringify(transcript)).toContain("Finish");
  });

  it("sends a tool result back to the model and then accepts the final answer", async () => {
    const model = mockModel([
      generated([toolCall("lookup", { input: "red" }, "lookup_1")]),
      finish("RED"),
    ]);
    expect(
      await defineAgent({
        id: "tool-then-finish",
        projectContext: false,
        defaultTools: [],
        tools: {
          lookup: defineTool({
            description: "Look up a value.",
            inputSchema: textSchema,
            outputSchema: textSchema,
            run: (input) => input.toUpperCase(),
          }),
        },
        model: aiSdkModel({ model, maxRetries: 0 }),
      }).runOrThrow({ task: "Look up red" })
    ).toEqual({ answer: "RED" });
    expect(model.doGenerateCalls).toHaveLength(2);
    expect(JSON.stringify(model.doGenerateCalls[1]?.prompt)).toContain("RED");
  });

  it("sends tool-call provider metadata back as provider options", async () => {
    const model = mockModel([
      generated([
        {
          ...toolCall("lookup", { input: "red" }, "lookup_1"),
          providerMetadata: { google: { thoughtSignature: "sig" } },
        },
      ]),
      finish("RED"),
    ]);
    expect(
      await defineAgent({
        id: "provider-metadata",
        projectContext: false,
        defaultTools: [],
        tools: {
          lookup: defineTool({
            description: "Look up a value.",
            inputSchema: textSchema,
            outputSchema: textSchema,
            run: (input) => input.toUpperCase(),
          }),
        },
        model: aiSdkModel({ model, maxRetries: 0 }),
      }).runOrThrow({ task: "Look up red" })
    ).toEqual({ answer: "RED" });
    const replayed = JSON.stringify(model.doGenerateCalls[1]?.prompt);
    expect(replayed).toContain('"providerOptions"');
    expect(replayed).toContain('"thoughtSignature":"sig"');
  });

  it("rejects a finish call mixed with another tool call", async () => {
    const model = mockModel(
      generated([
        toolCall("lookup", { input: "red" }, "lookup_1"),
        toolCall("_finish", { result: { answer: "Done." } }, "finish"),
      ])
    );
    const result = await defineAgent({
      id: "mixed-finish",
      projectContext: false,
      defaultTools: [],
      tools: {
        lookup: defineTool({
          description: "Look up a value.",
          inputSchema: textSchema,
          outputSchema: textSchema,
          run: (input) => input,
        }),
      },
      model: aiSdkModel({ model, maxRetries: 0 }),
    }).run({ task: "Finish" });
    expect(result.status).toBe("failed");
    expect(JSON.stringify(result.errors)).toContain("must finish without other calls");
    expect(model.doGenerateCalls).toHaveLength(1);
  });

  it("asks once more when the model returns text and then accepts the tool call", async () => {
    const model = mockModel([
      generated([{ type: "text", text: "I should call a tool." }], "stop"),
      finish(),
    ]);
    const transcript: unknown[] = [];
    expect(
      await defineAgent({
        id: "text-then-tool",
        projectContext: false,
        defaultTools: [],
        transcript: {
          write(record) {
            transcript.push(record);
          },
        },
        model: aiSdkModel({ model, maxRetries: 0 }),
      }).runOrThrow({ task: "Finish" })
    ).toEqual({ answer: "Done." });
    expect(model.doGenerateCalls).toHaveLength(2);
    expect(JSON.stringify(model.doGenerateCalls[1]?.prompt)).toContain("Call _finish alone");
    expect(JSON.stringify(transcript)).toContain("I should call a tool.");
  });

  it("fails when a second response still contains no tool call", async () => {
    const model = mockModel([
      generated([{ type: "text", text: "hello" }], "stop"),
      generated([{ type: "text", text: "still text" }], "stop"),
    ]);
    const result = await agent(aiSdkModel({ model, maxRetries: 0 }), "no-tools").run({
      task: "Finish",
    });
    expect(result.status).toBe("failed");
    expect(JSON.stringify(result.errors)).toContain("returned no tool calls");
    expect(model.doGenerateCalls).toHaveLength(2);
  });

  it("exports one decision usage trace for the AI SDK request", async () => {
    const events: unknown[] = [];
    const model = mockModel(finish());
    await agent(aiSdkModel({ model, maxRetries: 0 }), "usage").runOrThrow(
      { task: "Finish" },
      {},
      {
        tracing: {
          exporter: {
            export(event) {
              if (
                event.name === "step.attempted" &&
                event.payload.attributes["agent.model.provider"]
              )
                events.push(event.payload.attributes);
            },
          },
        },
      }
    );
    expect(events).toEqual([
      expect.objectContaining({
        "agent.model.provider": "mock",
        "agent.model.name": "mock-model",
        "agent.model.operation": "decision",
        "agent.model.request": 1,
        "agent.model.responseReceived": true,
        "agent.model.inputTokens": 20,
        "agent.model.uncachedInputTokens": 15,
        "agent.model.outputTokens": 6,
        "agent.model.cacheReadTokens": 4,
        "agent.model.cacheWriteTokens": 1,
        "agent.model.reasoningTokens": 1,
      }),
    ]);
  });

  it.each<Partial<AiSdkModelOptions>>([
    {},
    { model: "" },
    { model: "   " },
    {
      model: {
        specificationVersion: "v3",
        provider: "mock",
        modelId: "mock-model",
      } as AiSdkLanguageModel,
    },
    { model: mockModel(finish()), timeoutMs: 0 },
    { model: mockModel(finish()), maxRetries: -1 },
    { model: mockModel(finish()), maxRetries: 1.5 },
    { model: mockModel(finish()), maxOutputTokens: 0 },
    { model: mockModel(finish()), reasoningEffort: "huge" as "low" },
  ])("rejects invalid configuration locally: %j", (options) => {
    expect(() => aiSdkModel(options as AiSdkModelOptions)).toThrow(
      "Invalid AI SDK model configuration"
    );
  });

  it("rejects relocated references at definition, before any model call", async () => {
    const model = mockModel(finish());
    const schema = {
      "~standard": {
        version: 1 as const,
        vendor: "fixture",
        validate: (value: unknown) => ({ value }),
        jsonSchema: {
          input: () => ({ $defs: { word: { type: "string" } }, $ref: "#/$defs/word" }),
        },
      },
    };
    const define = (transport: AgentModel) =>
      defineAgent({
        id: "references",
        projectContext: false,
        defaultTools: [],
        tools: {
          custom: defineTool({
            description: "Custom",
            inputSchema: schema,
            outputSchema: schema,
            run: (input) => input,
          }),
        },
        model: transport,
      });
    const adapter = aiSdkModel({ model, maxRetries: 0 });
    expect(() => define(adapter)).toThrow(
      expect.objectContaining({
        code: "TUBELESS_AGENT_INVALID_DEFINITION",
        message: expect.stringContaining("$ref is unsupported"),
      })
    );
    const result = await define((request, context) => adapter(request, context)).run({
      task: "Finish",
    });
    expect(result.status).toBe("failed");
    expect(result.errors[0]?.message).toContain("$ref is unsupported");
    expect(model.doGenerateCalls).toHaveLength(0);
  });

  it("continues a session by closing the previous finish before the next task", async () => {
    const model = mockModel([finish("First."), finish("Second.")]);
    const session = createAgentSession(agent(aiSdkModel({ model, maxRetries: 0 }), "session"));
    expect(await session.runOrThrow({ task: "First task" })).toEqual({ answer: "First." });
    expect(await session.runOrThrow({ task: "Second task" })).toEqual({ answer: "Second." });
    const second = JSON.stringify(model.doGenerateCalls[1]?.prompt);
    expect(second).toContain("First task");
    expect(second).toContain("Second task");
    expect(second).toContain("First.");
  });

  it("marks an oversized tool result as truncated", async () => {
    const model = mockModel([
      generated([toolCall("lookup", { input: "wide" }, "lookup_1")]),
      finish(),
    ]);
    await defineAgent({
      id: "truncated",
      projectContext: false,
      defaultTools: [],
      tools: {
        lookup: defineTool({
          description: "Return a wide value.",
          inputSchema: textSchema,
          outputSchema: textSchema,
          run: () => "x".repeat(300_000),
        }),
      },
      model: aiSdkModel({ model, maxRetries: 0 }),
    }).runOrThrow({ task: "Read it" });
    expect(JSON.stringify(model.doGenerateCalls[1]?.prompt)).toContain("truncated");
  });

  it("reports the configured decision deadline as a failure and aborts the model call", async () => {
    const model = mockModel(
      ({ abortSignal }) =>
        new Promise((_resolve, reject) => {
          abortSignal?.addEventListener("abort", () => reject(abortSignal.reason), { once: true });
        })
    );
    const result = await agent(aiSdkModel({ model, timeoutMs: 25, maxRetries: 0 }), "deadline").run(
      {
        task: "Work",
      }
    );
    expect(result.status).toBe("failed");
    expect(JSON.stringify(result.errors)).toContain("timed out after 25 ms");
    expect(JSON.stringify(result.errors)).not.toContain("TUBELESS_RUN_CANCELLED");
    expect(model.doGenerateCalls[0]?.abortSignal?.aborted).toBe(true);
    expect(model.doGenerateCalls).toHaveLength(1);
  });

  it("rejects an invalid stored conversation before calling the model", async () => {
    const model = mockModel(finish());
    const transport = aiSdkModel({ model, maxRetries: 0 });
    const result = await defineAgent({
      id: "invalid-conversation",
      projectContext: false,
      defaultTools: [],
      model: (request, context) => transport({ ...request, conversation: { bad: true } }, context),
    }).run({ task: "Finish" });
    expect(result.status).toBe("failed");
    expect(result.errors[0]?.message).toContain("Invalid AI SDK conversation state");
    expect(model.doGenerateCalls).toHaveLength(0);
  });

  it("fails a content filter or length stop without a reminder request", async () => {
    const filtered = mockModel(generated([{ type: "text", text: "no" }], "content-filter"));
    const filterResult = await agent(aiSdkModel({ model: filtered, maxRetries: 0 }), "filter").run({
      task: "Finish",
    });
    expect(filterResult.status).toBe("failed");
    expect(JSON.stringify(filterResult.errors)).toContain("content filter");
    expect(filtered.doGenerateCalls).toHaveLength(1);

    const limited = mockModel(generated([], "length"));
    const limitResult = await agent(aiSdkModel({ model: limited, maxRetries: 0 }), "length").run({
      task: "Finish",
    });
    expect(limitResult.status).toBe("failed");
    expect(JSON.stringify(limitResult.errors)).toContain("maxOutputTokens");
    expect(limited.doGenerateCalls).toHaveLength(1);
  });

  it("rejects tool arguments that are not the single input or result field", async () => {
    const model = mockModel(generated([toolCall("lookup", { query: "red" }, "lookup_1")]));
    const result = await defineAgent({
      id: "bad-arguments",
      projectContext: false,
      defaultTools: [],
      tools: {
        lookup: defineTool({
          description: "Look up a value.",
          inputSchema: textSchema,
          outputSchema: textSchema,
          run: (input) => input,
        }),
      },
      model: aiSdkModel({ model, maxRetries: 0 }),
    }).run({ task: "Look up" });
    expect(result.status).toBe("failed");
    expect(JSON.stringify(result.errors)).toContain("exactly one input field");
  });

  it("rejects a new prompt whose conversation still has unfinished tool calls", async () => {
    const model = mockModel(finish());
    const transport = aiSdkModel({ model, maxRetries: 0 });
    const result = await defineAgent({
      id: "unfinished",
      projectContext: false,
      defaultTools: [],
      model: (request, context) =>
        transport(
          {
            ...request,
            conversation: [
              {
                role: "assistant",
                content: [
                  {
                    type: "tool-call",
                    toolCallId: "lookup_1",
                    toolName: "lookup",
                    input: { input: "red" },
                  },
                ],
              },
            ],
          },
          context
        ),
    }).run({ task: "Next" });
    expect(result.status).toBe("failed");
    expect(result.errors[0]?.message).toContain("unfinished tool calls");
    expect(model.doGenerateCalls).toHaveLength(0);
  });
});
