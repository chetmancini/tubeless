import type { AgentModel } from "tubeless/agent";
import { openaiModel } from "tubeless/agent/openai";

/** A REPL plugin factory; replace this transport with your own AgentModel adapter. */
export default function createModel({
  model,
  signal,
  env,
}: {
  readonly model: string;
  readonly signal: AbortSignal;
  readonly env: Readonly<NodeJS.ProcessEnv>;
}): AgentModel {
  signal.throwIfAborted();
  return openaiModel({ model, apiKey: env.OPENAI_API_KEY });
}
