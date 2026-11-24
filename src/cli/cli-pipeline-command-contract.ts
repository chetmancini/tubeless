import type { PipelinePlan, PipelineRunControls } from "../core/pipeline.js";
import { pipelineForCommand } from "../utilities/pipeline-command-marker.js";
import type { CliCommandDescriptor, CliContext } from "./cli-types.js";

export type PipelineCommandParseResult =
  | { kind: "values"; values: Record<string, unknown> }
  | { kind: "help"; helpText: string }
  | { kind: "error"; errors: readonly string[]; helpText: string };

/** Structured command operations shared by the workbench and hosting. */
export interface PipelineCommandContract {
  readonly id: string;
  readonly descriptor: CliCommandDescriptor;
  parseValues(
    values: Record<string, unknown>,
    context?: Partial<CliContext>
  ): PipelineCommandParseResult;
  execute(values: Record<string, unknown>, context?: Partial<CliContext>): Promise<unknown>;
  plan(controls?: PipelineRunControls): PipelinePlan;
}

export function isPipelineCommandContract(value: unknown): value is PipelineCommandContract {
  if (!pipelineForCommand(value)) return false;
  const candidate = value as object;
  return (
    "id" in candidate &&
    typeof candidate.id === "string" &&
    "descriptor" in candidate &&
    typeof candidate.descriptor === "object" &&
    candidate.descriptor !== null &&
    "parseValues" in candidate &&
    typeof candidate.parseValues === "function" &&
    "execute" in candidate &&
    typeof candidate.execute === "function" &&
    "plan" in candidate &&
    typeof candidate.plan === "function"
  );
}
