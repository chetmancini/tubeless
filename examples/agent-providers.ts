import type { AgentProvider } from "tubeless/cli";
import { anthropicModel } from "tubeless/agent/anthropic";

/** Named services choose their own API adapter, endpoint, authentication and feature support. */
export default {
  baseten: {
    model: "deepseek-ai/DeepSeek-V4.1-Flash-1017",
    modelEnv: "BASETEN_MODEL",
    credentialEnv: ["BASETEN_API_KEY"],
    createModel: ({ model, env }) =>
      anthropicModel({
        model,
        baseUrl: env.BASETEN_BASE_URL?.trim() || "https://inference.baseten.co",
        authToken: env.BASETEN_API_KEY?.trim(),
        strict: false,
        promptCaching: false,
        compactAfterBytes: null,
      }),
  },
} satisfies Readonly<Record<string, AgentProvider>>;
