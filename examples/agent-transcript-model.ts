import type { AgentModelFactory } from "tubeless/cli";

/** A credential-free model for demonstrating direct SQLite capture with the built-in agent CLI. */
const createModel: AgentModelFactory = () => (_request, context) => ({
  conversation: null,
  decision:
    context.turn === 1
      ? {
          kind: "continue",
          calls: [{ id: "list", tool: "list", input: { path: "." } }],
        }
      : { kind: "finish", result: { answer: "Listed the current directory." } },
});

export default createModel;
