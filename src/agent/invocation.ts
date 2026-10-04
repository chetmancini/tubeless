import { setExecutionScope } from "../core/execution-scope.js";
import type { PipelineDefinitionSnapshot, PipelineStepContext } from "../core/pipeline-types.js";
import { throwIfAborted } from "../utilities/abort.js";
import { agentError, ownState } from "./agent-state.js";
import type { AgentLimits, AgentState } from "./agent-types.js";
import type { AgentDurability } from "./checkpoint-types.js";
import type { SavedAgent } from "./checkpoint-format.js";
import { AgentCheckpointSession } from "./checkpoint-session.js";
import {
  checkEnvironment,
  environmentOperation,
  type AgentEnvironmentProvider,
} from "./environment.js";
import { AgentExecutionScope, agentScope } from "./execution-scope.js";
import type { TurnState } from "./turn.js";

export function initialAgentExecution<State>(
  initialize: () => State,
  saved?: SavedAgent["execution"]
): TurnState<State> {
  // SAFETY: recovery matched the owning definition and inputs before restoring its state.
  if (saved) return { ...saved, state: ownState(saved.state) as AgentState<State> };
  return { state: ownState(initialize()), turn: 1, stateVersion: 0, calls: 0 };
}

/** Own workspace resolution, recovery and lease lifetime for one agent invocation. */
export async function runAgentInvocation<Options extends object, State>(
  config: {
    id: string;
    implementationVersion?: string;
    environment?: AgentEnvironmentProvider;
    durability?: AgentDurability<Options>;
    initialState(options: Options): State;
    limits: Required<AgentLimits>;
    resolveCwd: boolean;
    definition: PipelineDefinitionSnapshot;
  },
  context: PipelineStepContext<Options>,
  run: (context: PipelineStepContext<Options>) => unknown
): Promise<unknown> {
  throwIfAborted(context.signal, "Agent workspace");
  const parent = agentScope(context);
  const provider = config.environment;
  const environment = checkEnvironment(
    provider !== undefined
      ? typeof provider === "function"
        ? await environmentOperation(context, () => provider(context))
        : provider
      : (parent?.environment ??
          (await import("./node-environment.js")).createNodeAgentEnvironment())
  );
  const cwd =
    config.resolveCwd || provider !== undefined
      ? await environmentOperation(context, () => environment.resolveCwd(context))
      : context.cwd;
  if (typeof cwd !== "string" || !cwd.trim() || cwd.length > 4096)
    throw new Error("Agent environment requires a nonblank cwd of at most 4096 characters");
  throwIfAborted(context.signal, "Agent workspace");
  const scoped = { ...context, cwd };
  const durability = context.dryRun ? undefined : config.durability;
  const inherited = context.dryRun ? undefined : parent?.journal;
  const journal =
    inherited ??
    (durability
      ? await AgentCheckpointSession.open(
          durability.store,
          typeof durability.key === "function" ? durability.key(context.options) : durability.key,
          durability.codec
        )
      : undefined);
  try {
    const scope = AgentExecutionScope.enter(
      scoped,
      config.limits,
      context.runId,
      environment,
      config.id,
      journal
    );
    setExecutionScope(scoped, scope);
    if (journal) {
      const saved = await journal.enter(
        scope.agentKey,
        {
          definition: JSON.stringify(config.definition.identity),
          implementationVersion: config.implementationVersion,
          options: context.options,
          environment: environment.id,
          cwd,
          cache: context.cachePolicy ?? "use",
        },
        { depth: scope.depth, limits: config.limits },
        () => initialAgentExecution(() => config.initialState(context.options))
      );
      if (saved.phase === "completed") return saved.result;
      if (saved.phase === "failed") throw agentError(saved.failure.code, saved.failure.message);
    }
    try {
      return await run(scoped);
    } catch (error) {
      await journal?.fail(scope.agentKey, error, context.signal);
      throw error;
    }
  } finally {
    if (journal && !inherited) await journal.close();
  }
}
