import { isCompiledPipeline } from "../core/pipeline-identity.js";
import type {
  Pipeline,
  PipelineDefinitionSnapshot,
  PipelineInput,
  PipelineResult,
  StandardSchemaV1,
} from "../core/pipeline-types.js";
import { agentError, checkDescription, jsonDescriptor } from "./agent-state.js";
import type { AgentTool, Input, Output } from "./agent-types.js";

type ChildPipeline = Pipeline<object, unknown>;
interface PipelineToolDefinition {
  description: string;
  inputSchema: StandardSchemaV1;
  inputJsonSchema: Readonly<Record<string, unknown>>;
  mapOptions?: (input: unknown) => object;
  pipeline: ChildPipeline & { readonly definition: PipelineDefinitionSnapshot };
}
const pipelineTools = new WeakMap<object, PipelineToolDefinition>();

/** Reuse a compiled child's options schema and exact final result. */
export function pipelineTool<const Child extends ChildPipeline>(
  pipeline: Child & { readonly optionsSchema: StandardSchemaV1 },
  metadata: {
    readonly description: string;
    readonly inputJsonSchema?: Readonly<Record<string, unknown>>;
  }
): AgentTool<PipelineInput<Child>, PipelineResult<Child>>;

/** Validate model arguments, map to raw child options, then validate the child's schema once. */
export function pipelineTool<
  const Child extends ChildPipeline,
  const Arguments extends StandardSchemaV1,
>(
  pipeline: Child,
  definition: {
    readonly description: string;
    readonly inputSchema: Arguments;
    readonly inputJsonSchema?: Readonly<Record<string, unknown>>;
    mapOptions(input: Output<Arguments>): PipelineInput<Child>;
  }
): AgentTool<Input<Arguments>, PipelineResult<Child>>;

export function pipelineTool<
  const Child extends ChildPipeline,
  const Arguments extends StandardSchemaV1,
>(
  pipeline: Child,
  definition: {
    readonly description: string;
    readonly inputSchema?: Arguments;
    readonly inputJsonSchema?: Readonly<Record<string, unknown>>;
    mapOptions?(input: Output<Arguments>): PipelineInput<Child>;
  }
): AgentTool<unknown, unknown> {
  checkDescription(definition.description);
  if (!isCompiledPipeline(pipeline) || !pipeline.definition)
    throw agentError(
      "TUBELESS_AGENT_INVALID_DEFINITION",
      "pipelineTool requires a compiled Tubeless pipeline"
    );
  const mapped = definition.inputSchema !== undefined;
  if (mapped ? typeof definition.mapOptions !== "function" : definition.mapOptions !== undefined)
    throw agentError(
      "TUBELESS_AGENT_INVALID_DEFINITION",
      "pipelineTool requires inputSchema and mapOptions together"
    );
  const inputSchema = definition.inputSchema ?? pipeline.optionsSchema!;
  const inputJsonSchema = jsonDescriptor(
    inputSchema,
    definition.inputJsonSchema,
    "Pipeline tool input"
  );
  // SAFETY: this private registry brands the descriptor; overloads correlate inputs and child results.
  const tool = Object.freeze({}) as AgentTool<unknown, unknown>;
  pipelineTools.set(tool, {
    description: definition.description,
    inputSchema,
    inputJsonSchema,
    // SAFETY: the dispatcher validates Arguments before calling this erased mapper.
    mapOptions: definition.mapOptions as ((input: unknown) => object) | undefined,
    pipeline: pipeline as ChildPipeline & { readonly definition: PipelineDefinitionSnapshot },
  });
  return tool;
}

export function compilePipelineTool(name: string, tool: object) {
  const definition = pipelineTools.get(tool);
  return definition ? { ...definition, name, kind: "pipeline" as const } : undefined;
}
