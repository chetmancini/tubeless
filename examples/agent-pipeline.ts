import { createSteps, definePipeline } from "tubeless";
import { definePipelineCommand } from "tubeless/cli";
import { DelegatingAgent } from "./agent-delegation.js";
import { textOptions } from "./agent.js";

const { step, fromPipeline } = createSteps(textOptions);

// Agents compose like any other child pipeline; the validated options are forwarded.
const answer = fromPipeline("answer", { pipeline: DelegatingAgent });
const report = step("report", {
  dependsOn: [answer],
  description: "Consume the agent's validated answer in ordinary pipeline work.",
  run: ({ answer }) => answer.answer,
});

export const AgentPipeline = definePipeline({
  id: "agent-pipeline",
  description: "Embed a delegating agent in an ordinary pipeline, including dry-run previews.",
  steps: [answer, report],
  finalize: report,
});

export const AgentPipelineCommand = definePipelineCommand(AgentPipeline, {
  summarize: (result) => [result],
});
