import { agentError } from "./agent-state.js";
import type { AgentCheckpointStore } from "./checkpoint-types.js";
import { checkCheckpointKey } from "./checkpoint-key.js";

/** In-memory checkpoint store with exclusive leases, useful for tests and embedded hosts. */
export function createMemoryAgentCheckpointStore(): AgentCheckpointStore {
  const values = new Map<string, string>();
  const owners = new Set<string>();
  return {
    acquire: async (key) => {
      checkCheckpointKey(key);
      if (owners.has(key))
        throw agentError(
          "TUBELESS_AGENT_EXECUTION_BUSY",
          `Agent execution ${key} is already owned`
        );
      owners.add(key);
      let closed = false;
      const check = () => {
        if (closed) throw new Error("Agent checkpoint lease is closed");
      };
      return {
        read: async () => {
          check();
          return values.get(key);
        },
        write: async (value) => {
          check();
          values.set(key, value);
        },
        close: async () => {
          if (!closed) {
            closed = true;
            owners.delete(key);
          }
        },
      };
    },
  };
}
