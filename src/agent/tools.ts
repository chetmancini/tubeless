import { createSteps, definePipeline } from "../core/pipeline.js";
import type { PipelineStepContext, StandardSchemaV1 } from "../core/pipeline-types.js";
import { agentError, checkSchema, jsonDescriptor } from "./agent-state.js";
import type { AgentTool, Awaitable, Input, Output } from "./agent-types.js";

/** A handler may throw this error to return a recoverable observation to its agent. */
export class ToolError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "ToolError";
    if (!code.trim() || code.length > 256 || message.length > 4096)
      throw new Error(
        "ToolError requires a nonblank code (up to 256 characters) and a message of at most 4096 characters"
      );
  }
}

interface ToolDefinition<Arguments extends StandardSchemaV1, Result extends StandardSchemaV1> {
  readonly description: string;
  readonly inputSchema: Arguments;
  readonly outputSchema: Result;
  readonly inputJsonSchema?: Readonly<Record<string, unknown>>;
  run(input: Output<Arguments>, context: PipelineStepContext<{}>): Awaitable<Input<Result>>;
  readonly dryRun?:
    | "skip"
    | ((input: Output<Arguments>, context: PipelineStepContext<{}>) => Awaitable<Input<Result>>);
}

const tools = new WeakMap<
  object,
  ToolDefinition<StandardSchemaV1, StandardSchemaV1> & {
    inputJsonSchema: Readonly<Record<string, unknown>>;
  }
>();

/** Declare a validated handler capability; tools skip live work in dry runs by default. */
export function defineTool<
  const Arguments extends StandardSchemaV1,
  const Result extends StandardSchemaV1,
>(definition: ToolDefinition<Arguments, Result>): AgentTool<Input<Arguments>, Output<Result>> {
  if (
    typeof definition.description !== "string" ||
    !definition.description.trim() ||
    definition.description.length > 4096
  )
    throw agentError(
      "TUBELESS_AGENT_INVALID_DEFINITION",
      "Tool description must be nonblank and at most 4096 characters"
    );
  checkSchema(definition.outputSchema, "Tool output");
  if (
    typeof definition.run !== "function" ||
    (definition.dryRun !== undefined &&
      definition.dryRun !== "skip" &&
      typeof definition.dryRun !== "function")
  )
    throw agentError(
      "TUBELESS_AGENT_INVALID_DEFINITION",
      "Tool requires a handler and a valid dry-run policy"
    );
  const inputJsonSchema = jsonDescriptor(
    definition.inputSchema,
    definition.inputJsonSchema,
    "Tool input"
  );
  // SAFETY: the private WeakMap brands this opaque descriptor and keeps its validators/handlers.
  const tool = Object.freeze({}) as AgentTool<Input<Arguments>, Output<Result>>;
  tools.set(tool, { ...definition, inputJsonSchema });
  return tool;
}

export interface ToolInvocation {
  input: unknown;
  attributes: Readonly<Record<string, string | number>>;
  expectedError?: ToolError;
}

export function compileTool(agentId: string, name: string, tool: AgentTool<unknown, unknown>) {
  const definition = tools.get(tool);
  if (!definition)
    throw agentError("TUBELESS_AGENT_INVALID_DEFINITION", `Tool ${name} must come from defineTool`);
  const { run, dryRun, inputSchema, outputSchema, inputJsonSchema, description } = definition;
  const invoke = async (handler: typeof run, context: PipelineStepContext<ToolInvocation>) => {
    context.reportAttempt(1, context.options.attributes);
    try {
      return await handler(context.options.input, { ...context, options: {} });
    } catch (error) {
      if (error instanceof ToolError) context.options.expectedError = error;
      throw error;
    }
  };
  const { step } = createSteps<ToolInvocation>();
  const call = step("tool", {
    description,
    outputSchema,
    run: (_inputs, context) => invoke(run, context),
    dryRun: typeof dryRun === "function" ? (_inputs, context) => invoke(dryRun, context) : "skip",
  });
  return {
    name,
    description,
    inputSchema,
    inputJsonSchema,
    pipeline: definePipeline({ id: `${agentId}/tool/${name}`, steps: [call], finalize: call }),
  };
}

export type CompiledTool = ReturnType<typeof compileTool>;
