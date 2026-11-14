import type { AgentModel } from "../agent/agent.js";

/** Create a model for one CLI prompt with the selected model and scoped environment. */
export type AgentModelFactory = (options: {
  readonly model: string;
  readonly signal: AbortSignal;
  readonly env: Readonly<Record<string, string | undefined>>;
}) => AgentModel | Promise<AgentModel>;

/** One named CLI model configuration; its factory owns the API, endpoint and authentication. */
export interface AgentProvider {
  /** Default model when neither --model nor modelEnv supplies one. */
  readonly model: string;
  /** Optional environment variable overriding the default model. */
  readonly modelEnv?: string;
  /** Credential environment variables in priority order; require the first nonblank value. */
  readonly credentialEnv?: readonly string[];
  /** Construct the adapter; read credentials from env rather than process.env. */
  readonly createModel: AgentModelFactory;
}
