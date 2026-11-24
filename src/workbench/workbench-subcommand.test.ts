import { describe, expect, it, vi } from "vitest";
import { TUBELESS_WORKBENCH_EXIT_CODE, type WorkbenchCliIo } from "./workbench-shared.js";
import { runWorkbenchSubcommand } from "./workbench-subcommand.js";

function captureIo(): WorkbenchCliIo & { errors: string[]; output: string[] } {
  const errors: string[] = [];
  const output: string[] = [];
  return {
    cwd: "/tmp",
    errors,
    output,
    stderr: {
      write: (chunk) => {
        errors.push(chunk);
      },
    },
    stdout: {
      write: (chunk) => {
        output.push(chunk);
      },
    },
  };
}

const spec = {
  name: "toy",
  usage: "Usage: toy <file>",
  positional: { min: 1, max: 1, error: "Pass exactly one file." },
  options: {
    json: { type: "boolean", description: "JSON output" },
    project: { type: "string", description: "Project", valueName: "path" },
  },
} as const;

function commandFixture() {
  return { spec, run: vi.fn(async () => TUBELESS_WORKBENCH_EXIT_CODE.success) };
}

describe("runWorkbenchSubcommand", () => {
  it.each([
    ["--jsn", "--jsn", "--json"],
    ["--projet=x.ts", "--projet", "--project"],
  ])("suggests a documented flag for %s", async (flag, name, suggestion) => {
    const io = captureIo();
    const command = commandFixture();
    const exitCode = await runWorkbenchSubcommand(command, [flag, "file"], io);
    expect(exitCode).toBe(TUBELESS_WORKBENCH_EXIT_CODE.usage);
    expect(io.errors.join("").split("\n")[0]).toBe(
      `Error: Unknown option: ${name}. Did you mean ${suggestion}?`
    );
    expect(io.output).toEqual([]);
    expect(command.run).not.toHaveBeenCalled();
  });

  it.each(["--verbose", "-x"])("reports %s without an unrelated suggestion", async (flag) => {
    const io = captureIo();
    const exitCode = await runWorkbenchSubcommand(commandFixture(), [flag, "file"], io);
    expect(exitCode).toBe(TUBELESS_WORKBENCH_EXIT_CODE.usage);
    expect(io.errors.join("").split("\n")[0]).toBe(`Error: Unknown option: ${flag}.`);
  });

  it("prints help before validating the positional count", async () => {
    const io = captureIo();
    const command = commandFixture();
    const exitCode = await runWorkbenchSubcommand(command, ["--help"], io);
    expect(exitCode).toBe(TUBELESS_WORKBENCH_EXIT_CODE.success);
    expect(io.output.join("")).toContain("Usage: toy <file>");
    expect(io.output.join("")).toContain("--project <path>");
    expect(io.errors).toEqual([]);
    expect(command.run).not.toHaveBeenCalled();
  });

  it.each([[], ["one", "two"]])("rejects a positional count mismatch for %j", async (...args) => {
    const io = captureIo();
    const command = commandFixture();
    const exitCode = await runWorkbenchSubcommand(command, args, io);
    expect(exitCode).toBe(TUBELESS_WORKBENCH_EXIT_CODE.usage);
    expect(io.errors.join("")).toMatch(/^Error: Pass exactly one file\./);
    expect(command.run).not.toHaveBeenCalled();
  });

  it("leaves command flags after the passthrough separator untouched", async () => {
    const io = captureIo();
    const command = {
      spec: { ...spec, passthrough: true },
      run: vi.fn(async (parsed: unknown) => {
        expect(parsed).toMatchObject({
          values: { json: true },
          positionals: ["pipeline.ts"],
          commandArgs: ["--help", "--flag", "--"],
        });
        return TUBELESS_WORKBENCH_EXIT_CODE.success;
      }),
    };
    const exitCode = await runWorkbenchSubcommand(
      command,
      ["--json", "pipeline.ts", "--", "--help", "--flag", "--"],
      io
    );
    expect(exitCode).toBe(TUBELESS_WORKBENCH_EXIT_CODE.success);
    expect(command.run).toHaveBeenCalledOnce();
    expect(io.errors).toEqual([]);
    expect(io.output).toEqual([]);
  });
});
