import type { CliParameterDescriptor } from "./cli.js";
import type { PipelinePlan, PipelineRunControls } from "./pipeline.js";

/** Untyped wire shape of a studio plan input; fields validated before use. */
interface StudioPlanInputWire {
  dryRun?: unknown;
  stepIds?: unknown;
  targets?: unknown;
}

/** Untyped wire shape of a studio parameter; fields validated before use. */
interface StudioParameterWire {
  choices?: unknown;
  default?: unknown;
  exclusive?: unknown;
  flag?: unknown;
  group?: unknown;
  key?: unknown;
  multiple?: unknown;
  positional?: unknown;
  required?: unknown;
  type?: unknown;
}

export interface PipelineRunStudioCommand {
  canPlan: boolean;
  description?: string;
  readonly id: string;
  readonly name: string;
  readonly parameters: readonly CliParameterDescriptor[];
}

export type PipelineRunStudioLaunchResult =
  | { accepted: true; runId: string }
  | { accepted: false; errors: readonly string[] };

export type PipelineRunStudioCancelResult =
  | { cancelled: true; runId: string }
  | { cancelled: false };

export interface PipelineRunStudioLaunchRequest {
  readonly values: Record<
    string,
    boolean | number | string | readonly number[] | readonly string[]
  >;
}

export interface PipelineRunStudioLauncher {
  readonly commands: readonly PipelineRunStudioCommand[];
  launch(
    commandId: string,
    values: PipelineRunStudioLaunchRequest["values"]
  ): Promise<PipelineRunStudioLaunchResult>;
  cancel?(runId: string): PipelineRunStudioCancelResult | Promise<PipelineRunStudioCancelResult>;
  /** Process-local live launch ids. Required with `cancel` for studio to advertise Cancel run. */
  liveRunIds?(): readonly string[];
  plan?(commandId: string, input: PipelineRunControls): PipelinePlan | Promise<PipelinePlan>;
}

export function parseStudioLaunchRequest(
  value: unknown
): PipelineRunStudioLaunchRequest | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value) || !("values" in value)) {
    return undefined;
  }
  const values = value.values;
  if (typeof values !== "object" || values === null || Array.isArray(values)) return undefined;
  const entries = Object.entries(values);
  if (entries.length > 128) return undefined;
  for (const [key, entry] of entries) {
    if (key.length === 0 || key.length > 4_096) return undefined;
    if (typeof entry === "boolean") continue;
    if (typeof entry === "number" && Number.isFinite(entry)) continue;
    if (typeof entry === "string" && entry.length <= 4_096) continue;
    if (
      Array.isArray(entry) &&
      entry.length <= 128 &&
      (entry.every((item) => typeof item === "string" && item.length <= 4_096) ||
        entry.every((item) => typeof item === "number" && Number.isFinite(item)))
    ) {
      continue;
    }
    return undefined;
  }
  // SAFETY: The loop above rejected any entry that is not a boolean, finite
  // number, bounded string, or bounded homogeneous array of those, so `values`
  // matches PipelineRunStudioLaunchRequest["values"].
  return { values: values as PipelineRunStudioLaunchRequest["values"] };
}

export function parseStudioPlanInput(value: unknown): PipelineRunControls | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  // SAFETY: The object guard above narrows `value` to a non-null object; this
  // wire shape only names the fields we read, leaving their values unchecked.
  const input = value as StudioPlanInputWire;
  if (input.dryRun !== undefined && typeof input.dryRun !== "boolean") return undefined;
  const selection = (key: "stepIds" | "targets"): readonly string[] | false | undefined => {
    const selected = input[key];
    if (selected === undefined) return undefined;
    if (
      !Array.isArray(selected) ||
      selected.length > 128 ||
      !selected.every((item) => typeof item === "string" && item.length <= 4_096)
    ) {
      return false;
    }
    return selected;
  };
  const stepIds = selection("stepIds");
  const targets = selection("targets");
  if (stepIds === false || targets === false) return undefined;
  const controls: PipelineRunControls = {};
  if (input.dryRun === true) controls.dryRun = true;
  if (stepIds !== undefined) controls.stepIds = stepIds;
  if (targets !== undefined) controls.targets = targets;
  return controls;
}

export function isPipelineRunStudioParameter(value: unknown): value is CliParameterDescriptor {
  if (typeof value !== "object" || value === null) return false;
  // SAFETY: The object guard above narrows `value` to a non-null object; this
  // wire shape only names the fields we validate below.
  const parameter = value as StudioParameterWire;
  if (
    typeof parameter.key !== "string" ||
    parameter.key.length === 0 ||
    typeof parameter.flag !== "string" ||
    parameter.flag.length === 0 ||
    typeof parameter.multiple !== "boolean" ||
    typeof parameter.positional !== "boolean" ||
    typeof parameter.required !== "boolean" ||
    !["boolean", "number", "path", "string"].includes(String(parameter.type))
  ) {
    return false;
  }
  if (
    parameter.choices !== undefined &&
    (!Array.isArray(parameter.choices) ||
      !parameter.choices.every((choice) => typeof choice === "string"))
  ) {
    return false;
  }
  if (
    parameter.default !== undefined &&
    typeof parameter.default !==
      (parameter.type === "boolean" ? "boolean" : parameter.type === "number" ? "number" : "string")
  ) {
    return false;
  }
  if (parameter.group !== undefined && parameter.group !== "execution") {
    return false;
  }
  if (parameter.exclusive !== undefined && parameter.exclusive !== true) {
    return false;
  }
  return true;
}
