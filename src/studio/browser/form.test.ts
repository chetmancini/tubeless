import { describe, expect, it } from "vitest";
import type { CliParameterDescriptor } from "../../cli/cli.js";
import type { PipelineRunStudioCommand } from "../shared/protocol.js";
import {
  createStudioLaunchForm,
  type StudioLaunchForm,
  serializeLaunchValues,
  serializePlanInput,
} from "./launch-form.js";

function parameter(
  key: string,
  overrides: Partial<CliParameterDescriptor> = {}
): CliParameterDescriptor {
  return {
    flag: `--${key}`,
    key,
    multiple: false,
    positional: false,
    required: false,
    type: "string",
    ...overrides,
  };
}

function command(parameters: readonly CliParameterDescriptor[]): PipelineRunStudioCommand {
  return { canPlan: true, id: "fixture", name: "Fixture", parameters };
}

function form(values: StudioLaunchForm["values"]): StudioLaunchForm {
  return { values, preservedKeys: new Set() };
}

describe("Studio form serialization", () => {
  it.each([
    ["scalar", parameter("__proto__"), ["provided"], "provided"],
    ["boolean", parameter("__proto__", { type: "boolean", default: false }), [true], true],
    ["repeatable", parameter("__proto__", { multiple: true }), ["one", "two"], ["one", "two"]],
  ] as const)(
    "preserves an own __proto__ %s value in launch JSON",
    (_name, descriptor, input, expected) => {
      const values = serializeLaunchValues(
        command([descriptor]),
        form(descriptor.multiple ? [[input.join("\n")]] : [input])
      );
      expect(Object.hasOwn(values, "__proto__")).toBe(true);
      expect(values["__proto__"]).toEqual(expected);
      expect(Object.getPrototypeOf(values)).toBe(Object.prototype);
      const decoded: Record<string, unknown> = JSON.parse(JSON.stringify(values));
      expect(Object.hasOwn(decoded, "__proto__")).toBe(true);
      expect(decoded["__proto__"]).toEqual(expected);
    }
  );

  it("starts multiple-choice controls with no selected values", () => {
    const parameters = [
      parameter("stepIds", { choices: ["load", "publish"], multiple: true }),
      parameter("targets", { multiple: true }),
      parameter("dryRun", { default: false, type: "boolean" }),
    ];

    expect(createStudioLaunchForm(command(parameters)).values).toEqual([[], [""], [false]]);
  });

  it("omits unchanged booleans and empty scalars from launch values", () => {
    const parameters = [
      parameter("enabled", { default: false, type: "boolean" }),
      parameter("verbose", { default: true, type: "boolean" }),
      parameter("name"),
      parameter("count", { type: "number" }),
    ];
    const values = [[false], [false], [""], [3]] as const;
    expect(serializeLaunchValues(command(parameters), form(values))).toEqual({
      verbose: false,
      count: 3,
    });
  });

  it("parses repeatable text and number controls into homogeneous multiple values", () => {
    const parameters = [
      parameter("targets", { multiple: true }),
      parameter("retries", { multiple: true, type: "number" }),
    ];
    const values = [["one\n\nthree"], ["1\n3"]] as const;
    expect(serializeLaunchValues(command(parameters), form(values))).toEqual({
      targets: ["one", "three"],
      retries: [1, 3],
    });
  });

  it("serializes only enabled execution selections for plans", () => {
    const parameters = [
      parameter("domain"),
      parameter("dryRun", { group: "execution", type: "boolean" }),
      parameter("targets", { group: "execution", multiple: true, choices: ["publish", "verify"] }),
      parameter("stepIds", { group: "execution", multiple: true }),
    ];
    const values = [["ignored"], [true], ["publish", "verify"], []] as const;
    expect(serializePlanInput(command(parameters), form(values))).toEqual({
      dryRun: true,
      targets: ["publish", "verify"],
    });
  });
});
