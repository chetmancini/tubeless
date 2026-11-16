import type { CliParameterDescriptor } from "../../cli/cli.js";
import type { PipelineRunControls } from "../../core/pipeline.js";
import type { StudioLaunchMetadata } from "../shared/launch-metadata.js";
import type {
  PipelineRunStudioCommand,
  PipelineRunStudioLaunchRequest,
} from "../shared/protocol.js";

export type StudioParameterValue = boolean | number | string;

/** Display values and the intentional empty strings that must survive submission. */
export interface StudioLaunchForm {
  readonly values: readonly (readonly StudioParameterValue[])[];
  readonly emptyKeys: ReadonlySet<string>;
  readonly review?: { readonly skipped: readonly string[]; readonly definitionChanged: boolean };
}

function initialValue(parameter: CliParameterDescriptor): StudioParameterValue[] {
  if (parameter.type === "boolean") return [Boolean(parameter.default)];
  if (parameter.multiple) return parameter.choices ? [] : [""];
  return parameter.default === undefined ? [""] : [parameter.default];
}

function compatible(parameter: CliParameterDescriptor, value: StudioParameterValue): boolean {
  if (parameter.choices && !parameter.choices.includes(String(value))) return false;
  // Repeatable text controls trim and split lines; never silently change saved data.
  if (
    parameter.multiple &&
    !parameter.choices &&
    typeof value === "string" &&
    (value === "" || value.trim() !== value || /[\r\n]/.test(value))
  )
    return false;
  if (typeof value !== "number") return true;
  return (
    Number.isFinite(value) &&
    (!parameter.integer || Number.isInteger(value)) &&
    (parameter.min === undefined || value >= parameter.min) &&
    (parameter.max === undefined || value <= parameter.max)
  );
}

/** Seed the current form once, reusing only compatible, explicitly recorded fields. */
export function createStudioLaunchForm(
  command: PipelineRunStudioCommand,
  previous?: StudioLaunchMetadata
): StudioLaunchForm {
  const emptyKeys = new Set<string>();
  if (previous?.commandId !== command.id)
    return { values: command.parameters.map(initialValue), emptyKeys };
  const saved = new Map(previous.inputs.recorded.map((input) => [input.key, input]));
  const skipped: string[] = [];
  const values = command.parameters.map((parameter): StudioParameterValue[] => {
    const input = saved.get(parameter.key);
    // Unsaved/absent inputs do not inherit an old value or a new scalar default.
    const blank = initialValue({
      ...parameter,
      default: parameter.type === "boolean" ? parameter.default : undefined,
    });
    if (!input || input.value === undefined) return blank;
    const values = Array.isArray(input.value) ? input.value : [input.value];
    if (
      input.type !== parameter.type ||
      input.multiple !== parameter.multiple ||
      !values.every((value) => compatible(parameter, value))
    ) {
      skipped.push(parameter.key);
      return blank;
    }
    if (input.value === "") emptyKeys.add(parameter.key);
    return parameter.multiple && !parameter.choices ? [values.join("\n")] : [...values];
  });
  const keys = new Set(command.parameters.map((parameter) => parameter.key));
  for (const key of saved.keys()) if (!keys.has(key)) skipped.push(key);
  return {
    values,
    emptyKeys,
    review: {
      skipped,
      definitionChanged:
        !previous.definitionId ||
        !command.definitionId ||
        previous.definitionId !== command.definitionId,
    },
  };
}

function readValues(
  form: StudioLaunchForm,
  parameter: CliParameterDescriptor,
  index: number
): readonly StudioParameterValue[] {
  const stored = form.values[index] ?? [];
  if (!parameter.multiple || parameter.choices) return stored;
  return String(stored[0] ?? "")
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => (parameter.type === "number" ? Number(value) : value));
}

/** Convert the rendered form to command values, preserving absence versus intentional emptiness. */
export function serializeLaunchValues(
  command: PipelineRunStudioCommand,
  form: StudioLaunchForm
): PipelineRunStudioLaunchRequest["values"] {
  const entries: [string, PipelineRunStudioLaunchRequest["values"][string]][] = [];
  command.parameters.forEach((parameter, index) => {
    const parameterValue = readValues(form, parameter, index);
    let value: PipelineRunStudioLaunchRequest["values"][string];
    if (parameter.type === "boolean") {
      const checked = parameterValue[0];
      if (checked === Boolean(parameter.default)) return;
      value = checked;
    } else if (parameter.multiple) {
      value =
        parameter.type === "number"
          ? parameterValue.filter((value): value is number => typeof value === "number")
          : parameterValue.filter((value): value is string => typeof value === "string");
    } else {
      const single = parameterValue[0];
      if (single === undefined || (single === "" && !form.emptyKeys.has(parameter.key))) return;
      value = single;
    }
    entries.push([parameter.key, value]);
  });
  return Object.fromEntries(entries);
}

/** Select execution controls from the same form representation used for launching. */
export function serializePlanInput(
  command: PipelineRunStudioCommand,
  form: StudioLaunchForm
): PipelineRunControls {
  const entries: [string, boolean | readonly string[]][] = [];
  command.parameters.forEach((parameter, index) => {
    if (parameter.group !== "execution") return;
    const values = readValues(form, parameter, index);
    if (parameter.type === "boolean") {
      if (values[0] === true) entries.push([parameter.key, true]);
    } else if (parameter.multiple && values.length)
      entries.push([
        parameter.key,
        values.filter((value): value is string => typeof value === "string"),
      ]);
  });
  return Object.fromEntries(entries);
}
