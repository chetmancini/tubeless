import { defineAgent, pipelineTool } from "tubeless/agent";
import { ScriptedAgent } from "./agent.js";

/** Chat with a project-defined agent and its delegated tools without model credentials. */
export const ChatAgent = defineAgent({
  id: "chat-agent",
  name: "Scripted chat agent",
  description: "Delegate text processing and retain the previous prompt in a chat session.",
  projectContext: false,
  defaultTools: [],
  tools: {
    processText: pipelineTool(ScriptedAgent, { description: "Process text with a child agent." }),
  },
  model: (request, context) => {
    if (context.turn === 1)
      return {
        decision: {
          kind: "continue",
          calls: [{ id: "process", tool: "processText", input: { question: request.task } }],
        },
        conversation: request.conversation,
      };
    const outcome = request.outcomes[0];
    if (!outcome?.ok) throw new Error("Text processing failed");
    return {
      decision: {
        kind: "finish",
        result: {
          answer: `Previous prompt: ${String(request.conversation ?? "none")}\n${JSON.stringify(outcome.value)}`,
        },
      },
      conversation: request.task,
    };
  },
});
