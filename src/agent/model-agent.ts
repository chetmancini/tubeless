import type { AgentEnvironmentProvider } from "./environment.js";
import type { StandardSchemaV1 } from "../core/pipeline-types.js";
import type { AgentLimits, AgentOutcome, Tools } from "./agent-types.js";
import type { AgentModel } from "./model-types.js";
import { compileAgent } from "./compile-agent.js";
import { agentError } from "./agent-state.js";
import { modelInstructions } from "./model-prompt.js";
import { toolObject } from "./default-tool-schema.js";
import { wireString } from "../tracing/wire-schema.js";

interface ModelState {
  instructions?: string;
  conversation: unknown;
  outcomes: readonly AgentOutcome<Tools>[];
}

const inputSchema: StandardSchemaV1<{ task: string }> = toolObject({
  task: wireString({ maxLength: 16_384 }),
});
const answer: StandardSchemaV1<{ answer: string }> = toolObject({ answer: wireString() });

/** Build a task-to-answer agent with default tools, prompting, project context, and owned conversation. */
export function defineModelAgent<
  const Id extends string,
  const Registry extends Tools = {},
>(config: {
  readonly id: Id;
  readonly name?: string;
  readonly description?: string;
  readonly implementationVersion?: string;
  readonly model: AgentModel;
  /** Append application instructions to the default coding prompt and project guidance. */
  readonly instructions?: string;
  /** Load AGENTS.md from the repository root through cwd; outside a repo, load cwd only. Defaults to true. */
  readonly projectContext?: boolean;
  readonly tools?: Registry;
  readonly limits?: AgentLimits;
  readonly environment?: AgentEnvironmentProvider;
}) {
  const { model, instructions, projectContext = true } = config;
  if (
    typeof model !== "function" ||
    (instructions !== undefined && typeof instructions !== "string") ||
    typeof projectContext !== "boolean"
  )
    throw agentError("TUBELESS_AGENT_INVALID_DEFINITION", "Invalid model agent configuration");
  return compileAgent(
    {
      ...config,
      inputSchema,
      resultSchema: answer,
      initialState: ({ task }): ModelState => {
        if (new TextEncoder().encode(task).length > 16_384)
          throw new Error("Task exceeds 16384 UTF-8 bytes");
        return { conversation: null, outcomes: [] };
      },
      decide: async (state, context) => {
        const prompt =
          state.instructions ??
          (await modelInstructions(
            context.cwd,
            instructions,
            projectContext,
            context.signal,
            context.environment
          ));
        const response = await model(
          { ...state, instructions: prompt, task: context.options.task },
          context
        );
        return {
          decision: response.decision,
          state: {
            instructions: prompt,
            conversation: response.conversation,
            outcomes: [],
          },
        };
      },
      reduce: (state, outcomes) => ({ ...state, outcomes }),
    },
    true
  );
}
