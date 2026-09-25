import type { PipelinePlan, PipelineStepContext } from "../core/pipeline-types.js";
import { validateStandardSchema } from "../core/pipeline-validation.js";
import { throwIfAborted } from "../utilities/abort.js";
import { agentError } from "./agent-state.js";
import type { CompiledTool } from "./tools.js";

export interface PreparedCall {
  id: string;
  tool: CompiledTool;
  input: unknown;
  plan: PipelinePlan;
}

function invalid(message: string): never {
  throw agentError("TUBELESS_AGENT_INVALID_DECISION", message);
}

function record(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

function keys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return (
    Reflect.ownKeys(value).length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key))
  );
}

export function decisionEnvelope(
  value: unknown
):
  | { kind: "finish"; result: unknown }
  | { kind: "continue"; calls: readonly { id: string; tool: string; input: unknown }[] } {
  if (!record(value)) return invalid("Agent decision must be a plain object");
  if (value.kind === "finish" && keys(value, ["kind", "result"]))
    return { kind: "finish", result: value.result };
  if (
    value.kind !== "continue" ||
    !keys(value, ["kind", "calls"]) ||
    !Array.isArray(value.calls) ||
    value.calls.length === 0
  )
    return invalid("Agent decision must finish(result) or continue with a nonempty calls array");
  const ids = new Set<string>();
  const calls = Array.from(value.calls, (call: unknown) => {
    if (
      !record(call) ||
      !keys(call, ["id", "tool", "input"]) ||
      typeof call.id !== "string" ||
      !call.id.trim() ||
      call.id.length > 256 ||
      typeof call.tool !== "string" ||
      !call.tool.trim()
    )
      return invalid("Each call requires a nonblank id (up to 256 characters), tool, and input");
    if (ids.has(call.id)) return invalid(`Duplicate agent call id: ${call.id}`);
    ids.add(call.id);
    return { id: call.id, tool: call.tool, input: call.input };
  });
  return { kind: "continue", calls };
}

export async function prepareCalls(
  calls: readonly { id: string; tool: string; input: unknown }[],
  registry: ReadonlyMap<string, CompiledTool>,
  context: PipelineStepContext<object>
): Promise<PreparedCall[]> {
  // Resolve the complete registry membership before invoking any argument validators.
  const entries = calls.map((call) => {
    const tool = registry.get(call.tool);
    if (!tool) return invalid(`Unknown agent tool: ${call.tool}`);
    return { call, tool };
  });
  const prepared: PreparedCall[] = [];
  for (const { call, tool } of entries) {
    throwIfAborted(context.signal, "Agent batch validation");
    const input = await validateStandardSchema(
      tool.inputSchema,
      call.input,
      `Agent tool ${call.tool} input`
    );
    throwIfAborted(context.signal, "Agent batch validation");
    const plan = tool.pipeline.plan({ dryRun: context.dryRun });
    if (!plan.ok) return invalid(`Agent tool ${call.tool} has an invalid plan`);
    prepared.push({ id: call.id, tool, input, plan });
  }
  return prepared;
}
