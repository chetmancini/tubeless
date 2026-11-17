import { describe, expect, it } from "vitest";
import { launchInputPolicy, recordedLaunch } from "./launch-metadata.js";
import { commands } from "./run.test-support.js";
import type { CliParameterDescriptor } from "../cli/cli.js";

const entry = commands.get("effect")!;
const parameter = (
  key: string,
  type: CliParameterDescriptor["type"],
  multiple = false
): CliParameterDescriptor => ({
  key,
  type,
  multiple,
  flag: `--${key}`,
  positional: false,
  required: false,
});

describe("launch input history policy", () => {
  it("requires explicit known fields, snapshots policy, and defaults to none", () => {
    expect(launchInputPolicy(commands).size).toBe(0);
    expect(() => launchInputPolicy(commands, { missing: [] })).toThrow(/command/);
    expect(() => launchInputPolicy(commands, { effect: ["typo"] })).toThrow(/parameter/);
    const keys = ["name"];
    const longId = "x".repeat(2048);
    expect(
      recordedLaunch(
        { ...entry, descriptor: { ...entry.descriptor, id: longId } },
        {},
        undefined,
        { launchId: "launch", deploymentId: undefined },
        {}
      ).commandId
    ).toBe(longId);
    const policy = launchInputPolicy(commands, { effect: keys });
    keys.push("dryRun");
    expect([...policy.get("effect")!]).toEqual(["name"]);
    expect(
      recordedLaunch(
        entry,
        { name: "private" },
        undefined,
        { launchId: "launch", deploymentId: undefined },
        {}
      ).inputs.recorded
    ).toEqual([]);
  });

  it("distinguishes omitted fields from absent, empty, false and zero values", () => {
    const command = {
      ...entry,
      descriptor: {
        ...entry.descriptor,
        parameters: [
          parameter("secret", "string"),
          parameter("absent", "string"),
          parameter("empty", "string"),
          parameter("off", "boolean"),
          parameter("zero", "number"),
          parameter("list", "string", true),
          parameter("__proto__", "string"),
        ],
      },
    };
    const result = recordedLaunch(
      command,
      JSON.parse(
        '{"secret":"private","empty":"","off":false,"zero":0,"list":[],"__proto__":"safe"}'
      ),
      new Set(["absent", "empty", "off", "zero", "list", "__proto__"]),
      { launchId: "launch", deploymentId: "release" },
      {}
    );
    expect(result.inputs).toEqual({
      recorded: [
        { key: "absent", type: "string", multiple: false },
        { key: "empty", type: "string", multiple: false, value: "" },
        { key: "off", type: "boolean", multiple: false, value: false },
        { key: "zero", type: "number", multiple: false, value: 0 },
        { key: "list", type: "string", multiple: true, value: [] },
        { key: "__proto__", type: "string", multiple: false, value: "safe" },
      ],
      omitted: ["secret"],
    });
    expect(JSON.stringify(result)).not.toContain("private");
  });
});
