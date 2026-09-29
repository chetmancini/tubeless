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
import { defaultTools } from "./default-tools.js";
import { setExecutionScope } from "../core/execution-scope.js";
import { AgentExecutionScope, resolvedLimits } from "./execution-scope.js";
import { createAgentTurn, type TurnState } from "./turn.js";
import { throwIfAborted } from "../utilities/abort.js";
import type {
  AgentDefinition,
  AgentDecisionContext,
  AgentState,
  Awaitable,
  Input,
  Output,
  Tools,
} from "./agent-types.js";

/** Accept raw or already-owned pending state; the turn snapshots it before tools run. */
export type RuntimeAgentDefinition<
  Id extends string,
  Options extends StandardSchemaV1<object, object>,
  Result extends StandardSchemaV1,
  State,
  Registry extends Tools,
> = Omit<AgentDefinition<Id, Options, Result, State, Registry>, "decide" | "dryRun"> & {
  decide(
    state: AgentState<State>,
    context: AgentDecisionContext<Output<Options>>
  ): Awaitable<{
    decision: unknown;
    state: State | AgentState<State>;
  }>;
  dryRun?(
    state: AgentState<State>,
    context: AgentDecisionContext<Output<Options>>
  ): Awaitable<{
    decision: unknown;
    state: State | AgentState<State>;
  }>;
};

export function compileAgent<
  const Id extends string,
  const Options extends StandardSchemaV1<object, object>,
  const Result extends StandardSchemaV1,
  State,
  const Registry extends Tools = {},
>(
  definition: RuntimeAgentDefinition<Id, Options, Result, State, Registry>,
  resolveCwd?: (cwd: string) => Promise<string>
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
  const entries = Object.entries({ ...defaultTools, ...config.tools }).sort(([a], [b]) =>
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
    initialState: (_inputs, context): TurnState<State> => {
      setExecutionScope(context, AgentExecutionScope.enter(context, limits, context.runId));
      return {
        state: ownState(config.initialState(context.options)),
        turn: 1,
        stateVersion: 0,
        calls: 0,
      };
    },
    mapOptions: (execution, _inputs, context) => ({
      execution,
      options: context.options,
      agentRunId: context.runId,
    }),
    transition: (result) => result,
  });
  const compiledAgent: AnyStep = agent;
  if (resolveCwd) {
    // Resolve once before iteration so decisions and all child calls share one cwd.
    const run = compiledAgent.run;
    compiledAgent.run = async (inputs, context) => {
      throwIfAborted(context.signal, "Agent workspace");
      return run(inputs, { ...context, cwd: await resolveCwd(context.cwd) });
    };
  }
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
