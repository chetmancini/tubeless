import type { LanguageModel } from "ai";
import { defineAgent } from "tubeless/agent";
import { aiSdkModel } from "tubeless/agent/ai-sdk";

/**
 * Workspace agent for any Vercel AI SDK language model.
 * Install `ai` and a provider package, then pass that model. Live runs make paid API requests.
 *
 * import { openai } from "@ai-sdk/openai";
 * export const agent = defineAiSdkCodingAgent(openai("gpt-5.4-mini"));
 */
export function defineAiSdkCodingAgent(model: LanguageModel) {
  return defineAgent({
    id: "ai-sdk-coding-agent",
    name: "Workspace coding agent (AI SDK)",
    description:
      "Investigate a task, edit the workspace, and verify the result with any AI SDK model.",
    implementationVersion: "ai-sdk-coding-agent-v1",
    model: aiSdkModel({ model, reasoningEffort: "high" }),
  });
}
