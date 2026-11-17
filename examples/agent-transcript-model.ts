import { randomUUID } from "node:crypto";
import type { AgentModelFactory } from "tubeless/cli";

/** Scripted model for demonstrating optional terminal streaming and direct SQLite capture. */
const createModel: AgentModelFactory =
  ({ text, signal }) =>
  async (_request, context) => {
    if (context.turn === 1)
      return {
        conversation: null,
        decision: { kind: "continue", calls: [{ id: "list", tool: "list", input: { path: "." } }] },
      };
    if (text) {
      const identity = {
        streamId: randomUUID(),
        provider: "anthropic" as const,
        turn: context.turn,
      };
      try {
        for (const word of ["The ", "directory ", "listing ", "is complete."]) {
          await context.sleep(80);
          await text({ ...identity, kind: "delta", text: word }, signal);
        }
      } catch (error) {
        // Best effort: the original failure matters more than a failed end event.
        try {
          await text({ ...identity, kind: "end", status: "interrupted" }, signal);
        } catch {
          // Ignored so the original error propagates.
        }
        throw error;
      }
      await text({ ...identity, kind: "end", status: "completed" }, signal);
    }
    return {
      conversation: null,
      decision: { kind: "finish", result: { answer: "Listed the current directory." } },
    };
  };

export default createModel;
