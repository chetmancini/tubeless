import { defineAgent, type AgentOutcome } from "tubeless/agent";
import { definePipelineCommand } from "tubeless/cli";
import { textAnswer, textOptions, textTools } from "./agent.js";
import { openaiDecision } from "./agent-openai-decision.js";

interface State {
  question: string;
  observations: readonly AgentOutcome<typeof textTools>[];
}

export const OpenAIAgent = defineAgent({
  id: "openai-agent",
  name: "OpenAI text agent",
  description: "Let a model select text tools, observe their results, and finish the task.",
  implementationVersion: "openai-text-v1",
  inputSchema: textOptions,
  resultSchema: textAnswer,
  tools: textTools,
  limits: { maxTurns: 6, maxDecisions: 6, maxCalls: 12, maxConcurrency: 3 },
  initialState: ({ question }): State => ({ question, observations: [] }),
  decide: openaiDecision,
  reduce: (state, outcomes) => ({
    ...state,
    observations: [...state.observations, ...outcomes],
  }),
  // No preview model: dry runs skip this agent and produce no final answer.
});

export const OpenAIAgentCommand = definePipelineCommand(OpenAIAgent, {
  summarize: ({ answer }) => [answer],
});
