import type { AgentProvider } from "../../cli/cli-agent-provider.js";
import { openaiModel } from "../../agent/openai.js";
import { anthropicModel } from "../../agent/anthropic.js";

/** Public-service presets. Protocol and endpoint choices belong to each factory. */
export const BUILTIN_AGENT_PROVIDERS = {
  openai: {
    model: "gpt-5.4-mini",
    modelEnv: "OPENAI_MODEL",
    credentialEnv: ["OPENAI_API_KEY"],
    createModel: ({ model, env }) =>
      openaiModel({
        model,
        apiKey: env.OPENAI_API_KEY?.trim(),
        baseUrl: env.OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1",
      }),
  },
  anthropic: {
    model: "claude-opus-5-5",
    modelEnv: "ANTHROPIC_MODEL",
    credentialEnv: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"],
    createModel: ({ model, env }) =>
      anthropicModel({
        model,
        ...(env.ANTHROPIC_API_KEY?.trim()
          ? { apiKey: env.ANTHROPIC_API_KEY.trim() }
          : { authToken: env.ANTHROPIC_AUTH_TOKEN?.trim() }),
        baseUrl: env.ANTHROPIC_BASE_URL?.trim() || "https://api.anthropic.com",
      }),
  },
} satisfies Readonly<Record<string, AgentProvider>>;
