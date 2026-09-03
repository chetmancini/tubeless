import { describe, expect, it } from "vitest";
import { TUBELESS_WORKBENCH_EXIT_CODE, type WorkbenchCliIo } from "./workbench-shared.js";
import { runWorkbenchSubcommand, type WorkbenchSubcommand } from "./workbench-subcommand.js";

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

interface ToyParsed {
  help: boolean;
  positionals: string[];
}

const TOY_USAGE = "Usage: toy <file>\n";

function toyCommand(
  run: WorkbenchSubcommand<ToyParsed>["run"] = async () => TUBELESS_WORKBENCH_EXIT_CODE.success
): WorkbenchSubcommand<ToyParsed> {
  return {
    usage: TOY_USAGE,
    parse(argv) {
      if (argv.includes("--bad")) throw new Error("Unknown option --bad");
      return {
        help: argv.includes("--help"),
        positionals: argv.filter((arg) => !arg.startsWith("-")),
      };
    },
    helpRequested: (parsed) => parsed.help,
    positionals: (parsed) => parsed.positionals,
    positionalCountError: {
      count: 1,
      message: "Pass exactly one pipeline or command file.",
    },
    run,
  };
}

describe("runWorkbenchSubcommand", () => {
  it("writes a usage error when parse throws", async () => {
    const io = captureIo();
    const exitCode = await runWorkbenchSubcommand(toyCommand(), ["--bad"], io);
    expect(exitCode).toBe(TUBELESS_WORKBENCH_EXIT_CODE.usage);
    expect(io.errors.join("")).toBe(`Error: Unknown option --bad\n\n${TOY_USAGE}`);
    expect(io.output).toEqual([]);
  });

  it("prints usage and succeeds when help is requested, before run", async () => {
    const io = captureIo();
    let ran = false;
    const exitCode = await runWorkbenchSubcommand(
      toyCommand(async () => {
        ran = true;
        return 99;
      }),
      ["--help", "extra"],
      io
    );
    expect(exitCode).toBe(TUBELESS_WORKBENCH_EXIT_CODE.success);
    expect(io.output.join("")).toBe(TOY_USAGE);
    expect(io.errors).toEqual([]);
    expect(ran).toBe(false);
  });

  it("rejects a positional count mismatch before run", async () => {
    const io = captureIo();
    let ran = false;
    const exitCode = await runWorkbenchSubcommand(
      toyCommand(async () => {
        ran = true;
        return 99;
      }),
      [],
      io
    );
    expect(exitCode).toBe(TUBELESS_WORKBENCH_EXIT_CODE.usage);
    expect(io.errors.join("")).toBe(
      `Error: Pass exactly one pipeline or command file.\n\n${TOY_USAGE}`
    );
    expect(ran).toBe(false);
  });
});
