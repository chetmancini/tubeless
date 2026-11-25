// Type-checked only: never executed. Declarations must not import the optional `ai` peer.
import type { AgentModel } from "tubeless/agent";
import { aiSdkModel, type AiSdkLanguageModel } from "tubeless/agent/ai-sdk";

const model: AiSdkLanguageModel = {
  specificationVersion: "v3",
  provider: "mock",
  modelId: "mock-model",
  async doGenerate() {
    return {
      content: [],
      finishReason: { unified: "stop", raw: "stop" },
      usage: {
        inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 0, text: 0, reasoning: 0 },
      },
      warnings: [],
    };
  },
};
// @ts-expect-error A model object must implement doGenerate.
const incomplete: AiSdkLanguageModel = {
  specificationVersion: "v3",
  provider: "mock",
  modelId: "incomplete",
};
const configured: AgentModel = aiSdkModel({
  model,
  reasoningEffort: "low",
  maxRetries: 0,
  maxOutputTokens: 256,
  timeoutMs: 1000,
});
const gateway: AgentModel = aiSdkModel({ model: "openai/gpt-5.4-mini" });
void configured;
void gateway;
void incomplete;
