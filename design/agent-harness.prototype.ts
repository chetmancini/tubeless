/** Stage 4 pipeline-tool declarations only; other probes use the implemented public API. */
import type { Pipeline, PipelineInput, PipelineResult, StandardSchemaV1 } from "tubeless";
import type { AgentTool } from "tubeless/agent";
export { defineAgent, defineTool, ToolError } from "tubeless/agent";
export type { AgentCall, AgentDecision, AgentOutcome } from "tubeless/agent";
type Output<S extends StandardSchemaV1> = NonNullable<S["~standard"]["types"]>["output"];
type Input<S extends StandardSchemaV1> = NonNullable<S["~standard"]["types"]>["input"];
type AnyPipeline = Pipeline<object, unknown>;

/** Reuse a child's schema when the model arguments already match its input. */
export declare function pipelineTool<const Child extends AnyPipeline>(
  pipeline: Child & { readonly optionsSchema: StandardSchemaV1 },
  metadata: {
    readonly description: string;
    readonly inputJsonSchema?: Readonly<Record<string, unknown>>;
  }
): AgentTool<PipelineInput<Child>, PipelineResult<Child>>;

/** Explicit boundary for schema-less children or differently shaped model arguments. */
export declare function pipelineTool<
  const Child extends AnyPipeline,
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
