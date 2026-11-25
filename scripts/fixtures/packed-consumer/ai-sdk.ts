// Type-checked only: never executed. Declarations must not import the optional `ai` peer.
import type { AgentModel } from "tubeless/agent";
import { aiSdkModel, type AiSdkLanguageModel } from "tubeless/agent/ai-sdk";

const model: AiSdkLanguageModel = {
  specificationVersion: "v3",
  provider: "mock",
  modelId: "mock-model",
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
