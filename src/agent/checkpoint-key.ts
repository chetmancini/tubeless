import { agentError } from "./agent-state.js";

export function checkCheckpointKey(key: string): void {
  if (typeof key !== "string" || !key.trim() || key.length > 4096)
    throw agentError(
      "TUBELESS_AGENT_INVALID_CHECKPOINT_KEY",
      "Agent execution key must be nonblank and at most 4096 characters"
    );
}
