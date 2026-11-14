import type { Pipeline } from "../core/pipeline-types.js";
import { createAgentSession, type AgentSession } from "./agent-session.js";
import { agentError } from "./agent-state.js";

type ChatAgent = Pipeline<{ task: string }, { answer: string }, "agent", "agent", string>;
const CHAT_SESSION = Symbol.for("tubeless/chat-agent-session/v1");

/** Register only defineAgent's default task/answer contract for CLI chat. */
export function registerChatAgent(agent: object): void {
  // The owning package instance creates the session, including separately installed copies.
  // SAFETY: defineAgent calls this only when both schemas are its task/answer defaults.
  Object.defineProperty(agent, CHAT_SESSION, {
    value: () => createAgentSession(agent as ChatAgent),
  });
}

/** Internal workbench boundary; typed agents keep their ordinary session support. */
export function createChatAgentSession(
  agent: unknown
): AgentSession<{ task: string }, { answer: string }> {
  const factory =
    typeof agent === "object" && agent !== null
      ? (agent as { [CHAT_SESSION]?: unknown })[CHAT_SESSION]
      : undefined;
  if (typeof factory !== "function")
    throw agentError(
      "TUBELESS_AGENT_INVALID_DEFINITION",
      "Chat requires defineAgent with the default { task } input and { answer } result schemas. Use tubeless run for typed agents or defineAgentLoop agents."
    );
  // SAFETY: defineAgent registers this versioned factory only for its default schemas.
  return factory() as AgentSession<{ task: string }, { answer: string }>;
}
