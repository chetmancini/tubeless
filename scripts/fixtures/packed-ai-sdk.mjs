import assert from "node:assert/strict";
import { MockLanguageModelV3 } from "ai/test";
import { defineAgent, defineTool } from "tubeless/agent";
import { aiSdkModel } from "tubeless/agent/ai-sdk";

const toolCall = (toolName, input, providerMetadata) => ({
  content: [
    {
      type: "tool-call",
      toolName,
      toolCallId: toolName,
      input: JSON.stringify(input),
      providerMetadata,
    },
  ],
  finishReason: { unified: "tool-calls", raw: "tool-calls" },
  usage: {
    inputTokens: { total: 2, noCache: 2, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
  },
  warnings: [],
});
const providerOptions = { google: { thoughtSignature: "fixture-signature" } };
const model = new MockLanguageModelV3({
  doGenerate: [
    toolCall("lookup", { input: "red" }, providerOptions),
    toolCall("_finish", { result: { answer: "RED" } }),
  ],
});
const stringSchema = {
  "~standard": {
    version: 1,
    vendor: "fixture",
    validate: (value) =>
      typeof value === "string" ? { value } : { issues: [{ message: "Expected text" }] },
    jsonSchema: { input: () => ({ type: "string" }) },
  },
};
const agent = defineAgent({
  id: "packed-ai-sdk",
  projectContext: false,
  defaultTools: [],
  model: aiSdkModel({ model, reasoningEffort: "xhigh", maxRetries: 0 }),
  tools: {
    lookup: defineTool({
      description: "Look up a value.",
      inputSchema: stringSchema,
      outputSchema: stringSchema,
      run: (value) => value.toUpperCase(),
    }),
  },
});
assert.deepEqual(await agent.runOrThrow({ task: "Look up red" }), { answer: "RED" });
assert.equal(model.doGenerateCalls.length, 2);
const [first, second] = model.doGenerateCalls;
assert.equal(first.reasoning, "xhigh");
assert.deepEqual(
  second.prompt.find(({ role }) => role === "assistant").content[0].providerOptions,
  providerOptions
);
const toolResult = second.prompt.find(({ role }) => role === "tool").content[0];
assert.equal(toolResult.toolCallId, "lookup");
assert.deepEqual(JSON.parse(toolResult.output.value), { ok: true, value: "RED" });
