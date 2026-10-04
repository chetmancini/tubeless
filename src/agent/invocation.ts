import { setExecutionScope } from "../core/execution-scope.js";
import type { PipelineStepContext } from "../core/pipeline-types.js";
import { throwIfAborted } from "../utilities/abort.js";
import {
  checkEnvironment,
  environmentOperation,
  type AgentEnvironmentProvider,
} from "./environment.js";
import { AgentExecutionScope, agentScope } from "./execution-scope.js";
import type { AgentLimits } from "./agent-types.js";

/** Resolve workspace authority once before entering the agent's turn loop. */
export async function runAgentInvocation<Options extends object>(
  config: {
    environment?: AgentEnvironmentProvider;
    limits: Required<AgentLimits>;
    resolveCwd: boolean;
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
  setExecutionScope(
    scoped,
    AgentExecutionScope.enter(scoped, config.limits, context.runId, environment)
  );
  return run(scoped);
}
