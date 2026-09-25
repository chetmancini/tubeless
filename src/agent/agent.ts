import { createSteps, definePipeline } from "../core/pipeline.js";
import { STEP_AGENT } from "../core/pipeline-step-metadata.js";
import type {
  Pipeline,
  PipelineDefinitionSnapshot,
  StandardSchemaV1,
} from "../core/pipeline-types.js";
import type { AnyStep } from "../core/pipeline-steps.js";
import {
  agentError,
  checkSchema,
  descriptorFingerprint,
  jsonDescriptor,
  ownState,
} from "./agent-state.js";
import { compileTool } from "./tools.js";
import { createAgentTurn, resolvedLimits, type TurnState } from "./turn.js";
import type { AgentDefinition, Input, Output, Tools } from "./agent-types.js";

export { defineTool, ToolError } from "./tools.js";
export type {
  AgentCall,
  AgentDecision,
  AgentDecisionContext,
  AgentLimits,
  AgentOutcome,
  AgentState,
  AgentTool,
} from "./agent-types.js";

/** Build a bounded in-process agent as an ordinary pipeline with one target, agent. */
export function defineAgent<
  const Id extends string,
  const Options extends StandardSchemaV1<object, object>,
  const Result extends StandardSchemaV1,
  State,
  const Registry extends Tools = {},
>(
  definition: AgentDefinition<Id, Options, Result, State, Registry>
): Pipeline<Input<Options>, Output<Result>, "agent", "agent", Id> & {
  readonly optionsSchema: Options;
  readonly definition: PipelineDefinitionSnapshot;
} {
  const config = { ...definition };
  checkSchema(config.inputSchema, "Agent input");
  if (
    typeof config.initialState !== "function" ||
    typeof config.decide !== "function" ||
    (config.reduce !== undefined && typeof config.reduce !== "function") ||
    (config.dryRun !== undefined && typeof config.dryRun !== "function")
  )
    throw agentError(
      "TUBELESS_AGENT_INVALID_DEFINITION",
      "Agent requires initialState and decide callbacks, and callable reduce/dryRun when supplied"
    );
  const limits = resolvedLimits(config.limits);
  const resultJsonSchema = jsonDescriptor(
    config.resultSchema,
    config.resultJsonSchema,
    "Agent result"
  );
  const entries = Object.entries(config.tools ?? {}).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0
  );
  if (entries.length > 4096)
    throw agentError(
      "TUBELESS_AGENT_INVALID_DEFINITION",
      "Agent capability inventory exceeds 4096 tools"
    );
  const registry = new Map(
    entries.map(([name, tool]) => {
      if (!/^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(name))
        throw agentError("TUBELESS_AGENT_INVALID_DEFINITION", `Invalid tool name: ${name}`);
      return [name, compileTool(config.id, name, tool)];
    })
  );
  const capabilities = Object.freeze(
    [...registry.values()].map(({ name, description, inputJsonSchema }) =>
      Object.freeze({ name, description, inputJsonSchema })
    )
  );
  const turn = createAgentTurn(config, registry, limits, { capabilities, resultJsonSchema });
  const { iteratePipeline } = createSteps(config.inputSchema);
  const agent = iteratePipeline("agent", {
    pipeline: turn,
    maxIterations: limits.maxTurns,
    dryRun: config.dryRun ? undefined : "skip",
    initialState: (_inputs, context): TurnState<State> => ({
      state: ownState(config.initialState(context.options)),
      turn: 1,
      stateVersion: 0,
      calls: 0,
    }),
    mapOptions: (execution, _inputs, context) => ({
      execution,
      options: context.options,
      agentRunId: context.runId,
    }),
    transition: (result) => result,
  });
  Object.defineProperty(agent, STEP_AGENT, {
    value: Object.freeze({
      limits,
      resultSchemaFingerprint: descriptorFingerprint(resultJsonSchema),
      capabilities: Object.freeze(
        [...registry.values()].map((tool) =>
          Object.freeze({
            name: tool.name,
            description: tool.description,
            inputSchemaFingerprint: descriptorFingerprint(tool.inputJsonSchema),
            identity: tool.pipeline.definition.identity,
          })
        )
      ),
    }),
  });
  const compiledAgent: AnyStep = agent;
  const pipeline = definePipeline({
    id: config.id,
    name: config.name,
    description: config.description,
    implementationVersion: config.implementationVersion,
    steps: [compiledAgent],
    finalize: compiledAgent,
  });
  // SAFETY: the sole iteration step inherits Options, publishes the once-validated Result,
  // and is the only target. This restores deferred generic inference at the factory boundary.
  return pipeline as unknown as Pipeline<Input<Options>, Output<Result>, "agent", "agent", Id> & {
    readonly optionsSchema: Options;
    readonly definition: PipelineDefinitionSnapshot;
  };
}
