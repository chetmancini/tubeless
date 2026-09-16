import type { CliParameterDescriptor } from "../cli/cli.js";
import type { PipelineRunControls } from "../core/pipeline.js";
import type {
  PipelineRunStudioCommand,
  PipelineRunStudioLaunchRequest,
} from "./run-store-ui-protocol.js";

export type StudioParameterValue = boolean | number | string;

export type ReadStudioParameterValues = (
  parameter: CliParameterDescriptor,
  index: number
) => readonly StudioParameterValue[];

/** Convert launch-form values into the bounded wire shape expected by the Studio API. */
export function serializeLaunchValues(
  command: PipelineRunStudioCommand,
  readValues: ReadStudioParameterValues
): PipelineRunStudioLaunchRequest["values"] {
  const values: PipelineRunStudioLaunchRequest["values"] = {};
  command.parameters.forEach((parameter, index) => {
    const parameterValue = readValues(parameter, index);
    if (parameter.type === "boolean") {
      const checked = parameterValue[0];
      if (checked !== Boolean(parameter.default)) values[parameter.key] = checked;
      return;
    }
    if (parameter.multiple) {
      values[parameter.key] =
        parameter.type === "number"
          ? parameterValue.filter((value): value is number => typeof value === "number")
          : parameterValue.filter((value): value is string => typeof value === "string");
      return;
    }
    const single = parameterValue[0];
    if (single !== "" && single !== undefined) values[parameter.key] = single;
  });
  return values;
}

/** Select only execution controls for plan requests. */
export function serializePlanInput(
  command: PipelineRunStudioCommand,
  readValues: ReadStudioParameterValues
): PipelineRunControls {
  const input: Record<string, boolean | readonly string[]> = {};
  command.parameters.forEach((parameter, index) => {
    if (parameter.group !== "execution") return;
    const values = readValues(parameter, index);
    if (parameter.type === "boolean") {
      if (values[0] === true) input[parameter.key] = true;
      return;
    }
    if (parameter.multiple && values.length) {
      input[parameter.key] = values.filter((value): value is string => typeof value === "string");
    }
  });
  // SAFETY: Execution controls are plan selections; the server parser ignores unknown keys.
  return input as PipelineRunControls;
}
