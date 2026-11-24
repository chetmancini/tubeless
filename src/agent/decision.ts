import { setExecutionScope } from "../core/execution-scope.js";
import { PreparedOptions } from "../core/prepared-options.js";
import { agentScope, type AgentExecutionScope } from "./execution-scope.js";
import type { PipelinePlan, PipelineStepContext } from "../core/pipeline-types.js";
import { validateStandardSchema } from "../core/pipeline-validation.js";
import { throwIfAborted } from "../utilities/abort.js";
import { agentError } from "./agent-errors.js";
import { isAgentCallId, isPlainRecord } from "./agent-values.js";
import type { CompiledTool, ToolInvocation } from "./tools.js";

type PreparedTool =
  | {
      kind: "handler";
      tool: Extract<CompiledTool, { kind: "handler" }>;
      input: unknown;
    }
  | {
      kind: "pipeline";
      tool: Extract<CompiledTool, { kind: "pipeline" }>;
      options: object;
      preparedOptions: PreparedOptions;
      scope: AgentExecutionScope;
    };

export type PreparedCall = PreparedTool & {
  id: string;
  plan: PipelinePlan;
};

function invalid(message: string): never {
  throw agentError("TUBELESS_AGENT_INVALID_DECISION", message);
}

function keys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return (
    Reflect.ownKeys(value).length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key))
  );
}

export function decisionEnvelope(
  value: unknown
): { kind: "finish"; result: unknown } | { kind: "continue"; calls: readonly unknown[] } {
  if (!isPlainRecord(value)) return invalid("Agent decision must be a plain object");
  if (value.kind === "finish" && keys(value, ["kind", "result"]))
    return { kind: "finish", result: value.result };
  if (
    value.kind !== "continue" ||
    !keys(value, ["kind", "calls"]) ||
    !Array.isArray(value.calls) ||
    value.calls.length === 0
  )
    return invalid("Agent decision must finish(result) or continue with a nonempty calls array");
  return { kind: "continue", calls: value.calls };
}

export async function prepareCalls(
  values: readonly unknown[],
  registry: ReadonlyMap<string, CompiledTool>,
  context: PipelineStepContext<object>,
  turn: number
): Promise<PreparedCall[]> {
  const ids = new Set<string>();
  const calls = Array.from(values, (call: unknown) => {
    if (
      !isPlainRecord(call) ||
      !keys(call, ["id", "tool", "input"]) ||
      !isAgentCallId(call.id) ||
      typeof call.tool !== "string" ||
      !call.tool.trim()
    )
      return invalid("Each call requires a nonblank id (up to 256 characters), tool, and input");
    if (ids.has(call.id)) return invalid(`Duplicate agent call id: ${call.id}`);
    ids.add(call.id);
    return { id: call.id, tool: call.tool, input: call.input };
  });
  const entries = calls.map((call) => {
    const tool = registry.get(call.tool);
    if (!tool) return invalid(`Unknown agent tool: ${call.tool}`);
    return { call, tool };
  });
  const prepared: PreparedCall[] = [];
  for (const { call, tool } of entries) {
    throwIfAborted(context.signal, "Agent batch validation");
    let invocation: PreparedTool;
    if (tool.kind === "pipeline") {
      const scope = agentScope(context)!.delegate(turn, call.id);
      const input = tool.mapOptions
        ? await validateStandardSchema(
            tool.inputSchema,
            call.input,
            `Agent tool ${call.tool} input`
          )
        : call.input;
      // SAFETY: the private preparation boundary checks object shape, even for schema-less children.
      const options = tool.mapOptions ? tool.mapOptions(input) : (input as object);
      const preparedOptions = await PreparedOptions.prepare(
        tool.pipeline.optionsSchema,
        options,
        `Pipeline ${tool.pipeline.id} options`
      );
      invocation = { kind: "pipeline", tool, options, preparedOptions, scope };
    } else {
      const input = await validateStandardSchema(
        tool.inputSchema,
        call.input,
        `Agent tool ${call.tool} input`
      );
      invocation = { kind: "handler", tool, input };
    }
    throwIfAborted(context.signal, "Agent batch validation");
    const plan = tool.pipeline.plan({ dryRun: context.dryRun, cache: context.cachePolicy });
    if (!plan.ok) return invalid(`Agent tool ${call.tool} has an invalid plan`);
    prepared.push({ ...invocation, id: call.id, plan });
  }
  return prepared;
}

export function callInvocation(
  call: PreparedCall,
  context: PipelineStepContext<object>,
  invocation: Omit<ToolInvocation, "input" | "call"> & { turn: number }
): { options: object; context: PipelineStepContext<object>; preparedOptions?: PreparedOptions } {
  if (call.kind === "handler") {
    const { turn, ...rest } = invocation;
    return {
      options: { ...rest, input: call.input, call: { turn, id: call.id } } satisfies ToolInvocation,
      context,
    };
  }
  const childContext = { ...context };
  setExecutionScope(childContext, call.scope);
  return { options: call.options, context: childContext, preparedOptions: call.preparedOptions };
}
