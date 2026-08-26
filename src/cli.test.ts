import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openCheckpoint, type CheckpointStore } from "./checkpoint";
import {
  CliHelpRequested,
  CliValidationError,
  defineCommand,
  definePipelineCommand,
  type CliContext,
} from "./cli";
import { createSteps, definePipeline } from "./pipeline";
import { renderPipelinePlan } from "./render";

function testLog(): CliContext["log"] & { lines: { level: string; message: string }[] } {
  const lines: { level: string; message: string }[] = [];
  return {
    lines,
    log: (message?: unknown) => lines.push({ level: "log", message: String(message) }),
    warn: (message?: unknown) => lines.push({ level: "warn", message: String(message) }),
    error: (message?: unknown) => lines.push({ level: "error", message: String(message) }),
  };
}

describe("defineCommand: string params", () => {
  it("exposes immutable structured parameter metadata", () => {
    const command = defineCommand({
      name: "import-rows",
      description: "Import source rows.",
      params: {
        source: {
          type: "path",
          description: "Input file.",
          flag: "input",
          kind: "file",
          mustExist: true,
        },
        format: { type: "string", choices: ["json", "csv"], default: "json" },
        limit: { type: "number", optional: true, integer: true, min: 1, max: 100 },
      },
      positionals: ["source"],
      run: (values) => values,
    });

    expect(command.descriptor).toMatchObject({
      description: "Import source rows.",
      name: "import-rows",
      parameters: [
        { default: false, flag: "dry-run", key: "dryRun", type: "boolean" },
        { default: false, flag: "resume", key: "resume", type: "boolean" },
        {
          description: "Input file.",
          flag: "input",
          key: "source",
          mustExist: true,
          pathKind: "file",
          positional: true,
          required: true,
          type: "path",
        },
        { choices: ["json", "csv"], default: "json", flag: "format", type: "string" },
        { flag: "limit", integer: true, max: 100, min: 1, required: false, type: "number" },
      ],
    });
    expect(Object.isFrozen(command.descriptor)).toBe(true);
    expect(Object.isFrozen(command.descriptor.parameters)).toBe(true);
    expect(Object.isFrozen(command.descriptor.parameters[2])).toBe(true);
    expect(Object.isFrozen(command.descriptor.parameters[3]?.choices)).toBe(true);
  });

  it("parses a provided value", () => {
    const command = defineCommand({
      params: { version: { type: "string" } },
      run: (values) => values,
    });
    const result = command.parse(["--version", "kjv"]);
    expect(result).toEqual({
      kind: "values",
      values: { version: "kjv", dryRun: false, resume: false },
    });
  });

  it("validates and executes structured values without argv tokenization", async () => {
    const run = vi.fn(
      (values: {
        attempts: readonly number[];
        count: number;
        dryRun: boolean;
        resume: boolean;
        tags: readonly string[];
      }) => `${values.count}:${values.attempts.join(",")}:${values.tags.join(",")}:${values.dryRun}`
    );
    const command = defineCommand({
      params: {
        attempts: { type: "number", multiple: true },
        count: { type: "number", integer: true, min: 1 },
        tags: { type: "string", multiple: true },
      },
      run,
    });

    const parsed = command.parseValues({
      attempts: [1, 2],
      count: 2,
      dryRun: true,
      tags: ["one", "two"],
    });

    expect(parsed).toEqual({
      kind: "values",
      values: { attempts: [1, 2], count: 2, dryRun: true, resume: false, tags: ["one", "two"] },
    });
    if (parsed.kind !== "values") throw new Error("Expected structured values to validate.");
    await expect(command.execute(parsed.values)).resolves.toBe("2:1,2:one,two:true");
    expect(run).toHaveBeenCalledTimes(1);
    expect(command.parseValues({ count: "2", tags: [] })).toMatchObject({
      kind: "error",
      errors: ["--count must be a finite number."],
    });
  });

  it("keeps boolean environment fallbacks when structured values omit the control", () => {
    const command = defineCommand({
      params: { enabled: { type: "boolean", env: "TUBELESS_ENABLED" } },
      run: (values) => values,
    });
    const context = { env: { TUBELESS_ENABLED: "true" } };

    expect(command.parseValues({}, context)).toMatchObject({
      kind: "values",
      values: { enabled: true },
    });
    expect(command.parseValues({ enabled: false }, context)).toMatchObject({
      kind: "values",
      values: { enabled: false },
    });
  });

  it("supports the --flag=value form", () => {
    const command = defineCommand({
      params: { version: { type: "string" } },
      run: (values) => values,
    });
    const result = command.parse(["--version=kjv"]);
    expect(result).toMatchObject({ kind: "values", values: { version: "kjv" } });
  });

  it("errors when a required string is missing", () => {
    const command = defineCommand({ params: { version: { type: "string" } }, run: (v) => v });
    const result = command.parse([]);
    expect(result.kind).toBe("error");
    expect(result.kind === "error" && result.errors).toEqual(["Missing required option --version"]);
  });

  it("returns undefined for an optional string that is absent", () => {
    const command = defineCommand({
      params: { book: { type: "string", optional: true } },
      run: (v) => v,
    });
    const result = command.parse([]);
    expect(result).toMatchObject({ kind: "values", values: { book: undefined } });
  });

  it("falls back to a default when absent", () => {
    const command = defineCommand({
      params: { version: { type: "string", default: "web" } },
      run: (v) => v,
    });
    expect(command.parse([])).toMatchObject({ kind: "values", values: { version: "web" } });
  });

  it("rejects a value outside of choices", () => {
    const command = defineCommand({
      params: { version: { type: "string", choices: ["kjv", "web"] } },
      run: (v) => v,
    });
    const result = command.parse(["--version", "niv"]);
    expect(result.kind).toBe("error");
    expect(result.kind === "error" && result.errors[0]).toContain("one of: kjv, web");
  });
});

describe("defineCommand: aliases, positionals, and environment fallbacks", () => {
  it("supports short aliases and includes them in generated help", () => {
    const command = defineCommand({
      params: {
        version: { type: "string", short: "v" },
        verbose: { type: "boolean", short: "V" },
      },
      run: (values) => values,
    });

    expect(command.parse(["-v", "kjv", "-V"])).toMatchObject({
      kind: "values",
      values: { version: "kjv", verbose: true },
    });
    const help = command.parse(["--help"]);
    expect(help.kind === "help" && help.helpText).toContain("-v, --version <string>");
  });

  it("rejects digit aliases so numeric positionals remain unambiguous", () => {
    expect(() =>
      defineCommand({
        params: { verbose: { type: "boolean", short: "3" } },
        run: () => undefined,
      })
    ).toThrow(/aliases must be one letter other than "h"/);
  });

  it("maps declared positional arguments and keeps negative numeric values valid", () => {
    const command = defineCommand({
      params: {
        book: { type: "string" },
        offset: { type: "number" },
      },
      positionals: ["book", "offset"],
      run: (values) => values,
    });

    expect(command.parse(["genesis", "-3"])).toMatchObject({
      kind: "values",
      values: { book: "genesis", offset: -3 },
    });
    expect(command.parse(["genesis", "-10"])).toMatchObject({
      kind: "values",
      values: { book: "genesis", offset: -10 },
    });
    expect(command.parse(["genesis", "-3.5"])).toMatchObject({
      kind: "values",
      values: { book: "genesis", offset: -3.5 },
    });
    expect(command.parse(["--book", "genesis", "3"])).toMatchObject({
      kind: "values",
      values: { book: "genesis", offset: 3 },
    });
  });

  it("keeps a repeatable positional active for every trailing token", () => {
    const command = defineCommand({
      params: { files: { type: "string", multiple: true } },
      positionals: ["files"],
      run: (values) => values,
    });

    expect(command.parse(["a.txt", "b.txt", "c.txt"])).toMatchObject({
      kind: "values",
      values: { files: ["a.txt", "b.txt", "c.txt"] },
    });
  });

  it("treats help-looking values as positionals after the end-of-options delimiter", () => {
    const command = defineCommand({
      params: { value: { type: "string" } },
      positionals: ["value"],
      run: (values) => values,
    });

    expect(command.parse(["--", "--help"])).toMatchObject({
      kind: "values",
      values: { value: "--help" },
    });
    expect(command.parse(["--", "-h"])).toMatchObject({
      kind: "values",
      values: { value: "-h" },
    });
  });

  it("uses environment fallbacks after argv, before defaults", () => {
    const command = defineCommand({
      params: { version: { type: "string", default: "web", env: "TUBELESS_VERSION" } },
      run: (values) => values,
    });
    const context = { env: { TUBELESS_VERSION: "kjv" } };

    expect(command.parse([], context)).toMatchObject({
      kind: "values",
      values: { version: "kjv" },
    });
    expect(command.parse(["--version", "asv"], context)).toMatchObject({
      kind: "values",
      values: { version: "asv" },
    });
  });

  it("validates environment fallbacks without exposing their values", () => {
    const command = defineCommand({
      params: { limit: { type: "number", integer: true, env: "TUBELESS_LIMIT" } },
      run: (values) => values,
    });
    const result = command.parse([], { env: { TUBELESS_LIMIT: "not-for-output" } });

    expect(result).toMatchObject({
      kind: "error",
      errors: ["environment variable TUBELESS_LIMIT must be a number"],
    });
    expect(result.kind === "error" && result.errors.join(" ")).not.toContain("not-for-output");
  });

  it("rejects ambiguous positional and environment declarations", () => {
    expect(() =>
      defineCommand({
        params: {
          names: { type: "string", multiple: true },
          version: { type: "string" },
        },
        positionals: ["names", "version"],
        run: () => undefined,
      })
    ).toThrow(/Repeatable positional parameter "names" must be last/);

    expect(() =>
      defineCommand({
        params: { names: { type: "string", multiple: true, env: "TUBELESS_NAMES" } },
        run: () => undefined,
      })
    ).toThrow(/combines multiple: true with env/);
  });

  it("marks runtime policy skips as conditional in a pipeline plan", async () => {
    const step = createSteps();
    const conditional = step.skippable("conditional", {
      skip: () => "disabled by configuration",
      run: () => undefined,
    });
    const pipeline = definePipeline({
      id: "conditional-plan",
      steps: [conditional],
      finalize: () => undefined,
    });
    const command = definePipelineCommand(pipeline, {
      mapOptions: () => ({}),
      reporter: false,
    });
    const plan = command.plan();

    expect(renderPipelinePlan(plan)).toContain("  - conditional: run (policy may skip)");
  });
});

describe("defineCommand: number params", () => {
  it("coerces a numeric string", () => {
    const command = defineCommand({ params: { limit: { type: "number" } }, run: (v) => v });
    expect(command.parse(["--limit", "50"])).toMatchObject({
      kind: "values",
      values: { limit: 50 },
    });
  });

  it("rejects a non-numeric value", () => {
    const command = defineCommand({ params: { limit: { type: "number" } }, run: (v) => v });
    const result = command.parse(["--limit", "abc"]);
    expect(result.kind).toBe("error");
    expect(result.kind === "error" && result.errors[0]).toContain('must be a number, got "abc"');
  });

  it("enforces integer, min, and max constraints", () => {
    const command = defineCommand({
      params: { limit: { type: "number", integer: true, min: 1, max: 10 } },
      run: (v) => v,
    });
    expect(command.parse(["--limit", "1.5"]).kind).toBe("error");
    expect(command.parse(["--limit", "0"]).kind).toBe("error");
    expect(command.parse(["--limit", "11"]).kind).toBe("error");
    expect(command.parse(["--limit", "5"])).toMatchObject({
      kind: "values",
      values: { limit: 5 },
    });
  });

  it("validates numeric defaults with the same constraints as argv values", () => {
    const invalidMinimum = defineCommand({
      params: { limit: { type: "number", default: 0, min: 1 } },
      run: (v) => v,
    });
    expect(invalidMinimum.parse([])).toMatchObject({
      kind: "error",
      errors: ["--limit must be >= 1, got 0"],
    });

    const invalidInteger = defineCommand({
      params: { limit: { type: "number", default: 1.5, integer: true } },
      run: (v) => v,
    });
    expect(invalidInteger.parse([])).toMatchObject({
      kind: "error",
      errors: ['--limit must be an integer, got "1.5"'],
    });
  });

  it("uses a default and supports optional absence", () => {
    const command = defineCommand({
      params: {
        withDefault: { type: "number", default: 40 },
        withoutDefault: { type: "number", optional: true },
      },
      run: (v) => v,
    });
    expect(command.parse([])).toMatchObject({
      kind: "values",
      values: { withDefault: 40, withoutDefault: undefined },
    });
  });
});

describe("defineCommand: multiple/repeatable params", () => {
  it("accumulates repeated string flags in order", () => {
    const command = defineCommand({
      params: { step: { type: "string", multiple: true } },
      run: (v) => v,
    });
    const result = command.parse(["--step", "a", "--step", "b"]);
    expect(result).toMatchObject({ kind: "values", values: { step: ["a", "b"] } });
  });

  it("resolves to [] when absent, for both string and number", () => {
    const command = defineCommand({
      params: {
        step: { type: "string", multiple: true },
        limit: { type: "number", multiple: true },
      },
      run: (v) => v,
    });
    expect(command.parse([])).toMatchObject({ kind: "values", values: { step: [], limit: [] } });
  });

  it("accumulates repeated --flag=value inline forms too", () => {
    const command = defineCommand({
      params: { step: { type: "string", multiple: true } },
      run: (v) => v,
    });
    const result = command.parse(["--step=a", "--step=b"]);
    expect(result).toMatchObject({ kind: "values", values: { step: ["a", "b"] } });
  });

  it("reports a choices violation for any repeated occurrence", () => {
    const command = defineCommand({
      params: { step: { type: "string", multiple: true, choices: ["a", "b"] } },
      run: (v) => v,
    });
    const result = command.parse(["--step", "a", "--step", "bogus", "--step", "b"]);
    expect(result.kind).toBe("error");
    expect(result.kind === "error" && result.errors[0]).toContain('got "bogus"');
  });

  it("reports every invalid occurrence, not just the first", () => {
    const command = defineCommand({
      params: { step: { type: "string", multiple: true, choices: ["a", "b"] } },
      run: (v) => v,
    });
    const result = command.parse(["--step", "bogus1", "--step", "bogus2"]);
    expect(result.kind).toBe("error");
    expect(result.kind === "error" && result.errors).toHaveLength(2);
    expect(result.kind === "error" && result.errors[0]).toContain('"bogus1"');
    expect(result.kind === "error" && result.errors[1]).toContain('"bogus2"');
  });

  it("reports a missing value at the end of argv", () => {
    const command = defineCommand({
      params: { step: { type: "string", multiple: true } },
      run: (v) => v,
    });
    const result = command.parse(["--step", "a", "--step"]);
    expect(result.kind).toBe("error");
    expect(result.kind === "error" && result.errors).toContain("Missing value for --step");
  });

  it("reports a missing value immediately followed by another flag", () => {
    const command = defineCommand({
      params: {
        step: { type: "string", multiple: true },
        other: { type: "boolean" },
      },
      run: (v) => v,
    });
    const result = command.parse(["--step", "--other"]);
    expect(result.kind).toBe("error");
    expect(result.kind === "error" && result.errors).toContain("Missing value for --step");
  });

  it("accumulates and validates repeated number flags", () => {
    const command = defineCommand({
      params: { limit: { type: "number", multiple: true, integer: true, min: 1 } },
      run: (v) => v,
    });
    expect(command.parse(["--limit", "1", "--limit", "2", "--limit", "3"])).toMatchObject({
      kind: "values",
      values: { limit: [1, 2, 3] },
    });

    const result = command.parse(["--limit", "1", "--limit", "abc"]);
    expect(result.kind).toBe("error");
    expect(result.kind === "error" && result.errors[0]).toContain("must be a number");
  });

  it("describes a multiple param as repeatable, never required", () => {
    const command = defineCommand({
      params: { step: { type: "string", multiple: true } },
      run: () => undefined,
    });
    const result = command.parse(["--help"]);
    expect(result.kind === "help" && result.helpText).toContain("repeatable");
    expect(result.kind === "help" && result.helpText).not.toContain("required");
  });

  it("throws at definition time when multiple is combined with a default", () => {
    expect(() =>
      defineCommand({
        params: { step: { type: "string", multiple: true, default: ["a"] } as never },
        run: () => undefined,
      })
    ).toThrow(/combines multiple: true with a default/);
  });

  it("throws at definition time when multiple is combined with optional", () => {
    expect(() =>
      defineCommand({
        params: { step: { type: "string", multiple: true, optional: true } },
        run: () => undefined,
      })
    ).toThrow(/combines multiple: true with optional/);
  });
});

describe("defineCommand: boolean params", () => {
  it("defaults to false", () => {
    const command = defineCommand({ params: { verbose: { type: "boolean" } }, run: (v) => v });
    expect(command.parse([])).toMatchObject({ kind: "values", values: { verbose: false } });
  });

  it("a bare flag sets true; --no-flag sets false", () => {
    const command = defineCommand({ params: { verbose: { type: "boolean" } }, run: (v) => v });
    expect(command.parse(["--verbose"])).toMatchObject({
      kind: "values",
      values: { verbose: true },
    });
    expect(command.parse(["--no-verbose"])).toMatchObject({
      kind: "values",
      values: { verbose: false },
    });
  });

  it("accepts explicit --flag=true/false", () => {
    const command = defineCommand({ params: { verbose: { type: "boolean" } }, run: (v) => v });
    expect(command.parse(["--verbose=true"])).toMatchObject({
      kind: "values",
      values: { verbose: true },
    });
    expect(command.parse(["--verbose=false"])).toMatchObject({
      kind: "values",
      values: { verbose: false },
    });
  });

  it("rejects a non-boolean inline value", () => {
    const command = defineCommand({ params: { verbose: { type: "boolean" } }, run: (v) => v });
    const result = command.parse(["--verbose=maybe"]);
    expect(result.kind).toBe("error");
  });

  it("rejects combining --no- with an inline value", () => {
    const command = defineCommand({ params: { verbose: { type: "boolean" } }, run: (v) => v });
    const result = command.parse(["--no-verbose=true"]);
    expect(result.kind).toBe("error");
  });

  it("derives the kebab-case flag name from a camelCase key", () => {
    const command = defineCommand({
      params: { allowAmbiguousUnscoped: { type: "boolean" } },
      run: (v) => v,
    });
    expect(command.parse(["--allow-ambiguous-unscoped"])).toMatchObject({
      kind: "values",
      values: { allowAmbiguousUnscoped: true },
    });
  });

  it("supports an explicit flag name override", () => {
    const command = defineCommand({
      params: { verbose: { type: "boolean", flag: "loud" } },
      run: (v) => v,
    });
    expect(command.parse(["--loud"])).toMatchObject({
      kind: "values",
      values: { verbose: true },
    });
  });

  it("matches a real flag literally named no-* exactly, instead of treating it as negation", () => {
    const command = defineCommand({
      params: { noCache: { type: "boolean" } },
      run: (v) => v,
    });
    expect(command.parse(["--no-cache"])).toMatchObject({
      kind: "values",
      values: { noCache: true },
    });
  });

  it("still negates an unrelated flag when the exact no-* name isn't registered", () => {
    const command = defineCommand({
      params: { verbose: { type: "boolean" } },
      run: (v) => v,
    });
    expect(command.parse(["--no-verbose"])).toMatchObject({
      kind: "values",
      values: { verbose: false },
    });
  });
});

describe("defineCommand: built-in --dry-run", () => {
  it("is available without being declared in params, and defaults to false", () => {
    const command = defineCommand({ params: {}, run: (v) => v });
    expect(command.parse([])).toMatchObject({ kind: "values", values: { dryRun: false } });
  });

  it("a bare --dry-run sets true; --no-dry-run sets false", () => {
    const command = defineCommand({ params: {}, run: (v) => v });
    expect(command.parse(["--dry-run"])).toMatchObject({
      kind: "values",
      values: { dryRun: true },
    });
    expect(command.parse(["--no-dry-run"])).toMatchObject({
      kind: "values",
      values: { dryRun: false },
    });
  });

  it("is listed in generated --help output", () => {
    const command = defineCommand({ params: {}, run: () => undefined });
    const result = command.parse(["--help"]);
    expect(result.kind === "help" && result.helpText).toContain("--dry-run");
  });

  it("composes with a command's own params", () => {
    const command = defineCommand({
      params: { version: { type: "string" } },
      run: (v) => v,
    });
    expect(command.parse(["--version", "kjv", "--dry-run"])).toMatchObject({
      kind: "values",
      values: { version: "kjv", dryRun: true },
    });
  });

  it("throws at definition time if a schema redeclares the dryRun key", () => {
    expect(() =>
      defineCommand({
        params: { dryRun: { type: "string" } as never },
        run: () => undefined,
      })
    ).toThrow(/"dryRun" is a reserved parameter/);
  });

  it("throws at definition time if a param's flag collides with --dry-run", () => {
    expect(() =>
      defineCommand({
        params: { preview: { type: "boolean", flag: "dry-run" } },
        run: () => undefined,
      })
    ).toThrow(/--dry-run is a reserved flag/);
  });

  it("throws at definition time if a param's flag collides with --help", () => {
    expect(() =>
      defineCommand({
        params: { showHelp: { type: "boolean", flag: "help" } },
        run: () => undefined,
      })
    ).toThrow(/--help is a reserved flag/);
  });
});

describe("defineCommand: path params", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-path-test-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("resolves a relative value against context.cwd", () => {
    const command = defineCommand({ params: { dataDir: { type: "path" } }, run: (v) => v });
    const result = command.parse(["--data-dir", "public/data"], { cwd: "/tmp/workspace" });
    expect(result).toMatchObject({
      kind: "values",
      values: { dataDir: path.join("/tmp/workspace", "public/data") },
    });
  });

  it("passes an absolute value through unchanged", () => {
    const command = defineCommand({ params: { dataDir: { type: "path" } }, run: (v) => v });
    const result = command.parse(["--data-dir", "/abs/data"], { cwd: "/tmp/workspace" });
    expect(result).toMatchObject({ kind: "values", values: { dataDir: "/abs/data" } });
  });

  it("resolves a relative default against context.cwd", () => {
    const command = defineCommand({
      params: { dataDir: { type: "path", default: "public/data" } },
      run: (v) => v,
    });
    const result = command.parse([], { cwd: "/tmp/workspace" });
    expect(result).toMatchObject({
      kind: "values",
      values: { dataDir: path.join("/tmp/workspace", "public/data") },
    });
  });

  it("errors when mustExist is set and the path is missing", () => {
    const command = defineCommand({
      params: { dataDir: { type: "path", mustExist: true } },
      run: (v) => v,
    });
    const missing = path.join(dir, "missing");
    const result = command.parse(["--data-dir", missing]);
    expect(result.kind).toBe("error");
    expect(result.kind === "error" && result.errors[0]).toContain("does not exist");
  });

  it("errors when kind is directory but the path is a file", () => {
    const filePath = path.join(dir, "file.txt");
    fs.writeFileSync(filePath, "hello");
    const command = defineCommand({
      params: { dataDir: { type: "path", mustExist: true, kind: "directory" } },
      run: (v) => v,
    });
    const result = command.parse(["--data-dir", filePath]);
    expect(result.kind).toBe("error");
    expect(result.kind === "error" && result.errors[0]).toContain("must be a directory");
  });

  it("accepts a directory when kind is directory", () => {
    const command = defineCommand({
      params: { dataDir: { type: "path", mustExist: true, kind: "directory" } },
      run: (v) => v,
    });
    const result = command.parse(["--data-dir", dir]);
    expect(result).toMatchObject({ kind: "values", values: { dataDir: dir } });
  });
});

describe("defineCommand: unknown/malformed args", () => {
  it("reports unknown options", () => {
    const command = defineCommand({ params: { version: { type: "string" } }, run: (v) => v });
    const result = command.parse(["--version", "kjv", "--bogus"]);
    expect(result.kind).toBe("error");
    expect(result.kind === "error" && result.errors).toContain("Unknown option: --bogus");
  });

  it("reports a missing value at the end of argv", () => {
    const command = defineCommand({ params: { version: { type: "string" } }, run: (v) => v });
    const result = command.parse(["--version"]);
    expect(result.kind).toBe("error");
    expect(result.kind === "error" && result.errors).toContain("Missing value for --version");
  });

  it("reports a bare positional argument", () => {
    const command = defineCommand({ params: {}, run: () => undefined });
    const result = command.parse(["genesis"]);
    expect(result.kind).toBe("error");
    expect(result.kind === "error" && result.errors[0]).toContain("Unexpected argument: genesis");
  });

  it("throws at definition time when two keys derive the same flag", () => {
    expect(() =>
      defineCommand({
        params: {
          verbose: { type: "boolean" },
          loud: { type: "boolean", flag: "verbose" },
        },
        run: () => undefined,
      })
    ).toThrow(/Duplicate --verbose flag/);
  });
});

describe("defineCommand: --help", () => {
  it("takes precedence over validation errors and lists every option", () => {
    const command = defineCommand({
      description: "Example command.",
      params: {
        version: { type: "string", choices: ["kjv", "web"], description: "Bible version" },
        limit: { type: "number", optional: true },
      },
      run: () => undefined,
    });
    const result = command.parse(["--help"]);
    expect(result.kind).toBe("help");
    expect(result.kind === "help" && result.helpText).toContain("--version <string>");
    expect(result.kind === "help" && result.helpText).toContain("one of: kjv, web");
    expect(result.kind === "help" && result.helpText).toContain("--limit <number>");
    expect(result.kind === "help" && result.helpText).toContain("Example command.");
  });

  it("-h is equivalent to --help", () => {
    const command = defineCommand({ params: {}, run: () => undefined });
    expect(command.parse(["-h"]).kind).toBe("help");
  });

  it("does not claim a path's kind constraint when mustExist is not set", () => {
    const command = defineCommand({
      params: { dataDir: { type: "path", kind: "directory" } },
      run: () => undefined,
    });
    const result = command.parse(["--help"]);
    expect(result.kind === "help" && result.helpText).not.toContain("must be a directory");
  });

  it("does claim a path's kind constraint when mustExist is set", () => {
    const command = defineCommand({
      params: { dataDir: { type: "path", mustExist: true, kind: "directory" } },
      run: () => undefined,
    });
    const result = command.parse(["--help"]);
    expect(result.kind === "help" && result.helpText).toContain("must be a directory");
  });
});

describe("defineCommand: validate hook", () => {
  it("runs after field-level validation and can add cross-field errors", () => {
    const command = defineCommand({
      params: {
        all: { type: "boolean" },
        version: { type: "string", optional: true },
      },
      validate: (values) =>
        values.all || values.version ? undefined : ["Pass --all or --version"],
      run: (v) => v,
    });
    const result = command.parse([]);
    expect(result.kind).toBe("error");
    expect(result.kind === "error" && result.errors).toEqual(["Pass --all or --version"]);
  });

  it("does not run when field-level validation already failed", () => {
    const validate = vi.fn();
    const command = defineCommand({
      params: { limit: { type: "number" } },
      validate,
      run: (v) => v,
    });
    command.parse(["--limit", "abc"]);
    expect(validate).not.toHaveBeenCalled();
  });
});

describe("defineCommand: checkpoint", () => {
  let dir: string;
  let checkpointPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-checkpoint-test-"));
    checkpointPath = path.join(dir, "run.checkpoint.json");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function seedCheckpoint(): void {
    const store = openCheckpoint(checkpointPath);
    store.record("a");
    store.flush();
  }

  it("starts fresh by default, clearing a pre-existing checkpoint before run is called", async () => {
    seedCheckpoint();
    let seenHasA: boolean | undefined;
    const command = defineCommand({
      checkpoint: { path: checkpointPath },
      params: {},
      run: (_v, context) => {
        seenHasA = context.checkpoint?.has("a");
      },
    });
    await command.run([]);
    expect(seenHasA).toBe(false);
    expect(fs.existsSync(checkpointPath)).toBe(false);
  });

  it("--resume preserves existing entries and logs a resuming message", async () => {
    seedCheckpoint();
    const log = testLog();
    let seenHasA: boolean | undefined;
    const command = defineCommand({
      checkpoint: { path: checkpointPath },
      params: {},
      run: (_v, context) => {
        seenHasA = context.checkpoint?.has("a");
      },
    });
    await command.run(["--resume"], { log });
    expect(seenHasA).toBe(true);
    expect(log.lines.some((l) => l.message.includes("Resuming from checkpoint"))).toBe(true);
  });

  it("warns when --resume is passed but no checkpoint file exists", async () => {
    const log = testLog();
    let seenHasA: boolean | undefined;
    const command = defineCommand({
      checkpoint: { path: checkpointPath },
      params: {},
      run: (_v, context) => {
        seenHasA = context.checkpoint?.has("a");
      },
    });
    await command.run(["--resume"], { log });
    expect(seenHasA).toBe(false);
    expect(
      log.lines.some((l) => l.level === "warn" && l.message.includes("no checkpoint was found"))
    ).toBe(true);
  });

  it("defaultResume: true resumes without a flag; --no-resume forces a fresh run", async () => {
    seedCheckpoint();
    let seenHasA: boolean | undefined;
    const command = defineCommand({
      checkpoint: { path: checkpointPath, defaultResume: true },
      params: {},
      run: (_v, context) => {
        seenHasA = context.checkpoint?.has("a");
      },
    });
    await command.run([]);
    expect(seenHasA).toBe(true);

    seedCheckpoint();
    await command.run(["--no-resume"]);
    expect(seenHasA).toBe(false);
  });

  it("throws at definition time if a schema redeclares resume, with or without checkpoint configured", () => {
    expect(() =>
      defineCommand({
        checkpoint: { path: checkpointPath },
        params: { resume: { type: "boolean" } as never },
        run: () => undefined,
      })
    ).toThrow(/"resume" is a reserved parameter/);
    expect(() =>
      defineCommand({
        params: { resume: { type: "boolean" } as never },
        run: () => undefined,
      })
    ).toThrow(/"resume" is a reserved parameter/);
  });

  it("throws at definition time if a param's flag collides with --resume, with or without checkpoint configured", () => {
    expect(() =>
      defineCommand({
        checkpoint: { path: checkpointPath },
        params: { continue: { type: "boolean", flag: "resume" } },
        run: () => undefined,
      })
    ).toThrow(/--resume is a reserved flag/);
    expect(() =>
      defineCommand({
        params: { continue: { type: "boolean", flag: "resume" } },
        run: () => undefined,
      })
    ).toThrow(/--resume is a reserved flag/);
  });

  it("throws at definition time if a param's flag collides with --no-resume, with or without checkpoint configured", () => {
    expect(() =>
      defineCommand({
        checkpoint: { path: checkpointPath },
        params: { continueFresh: { type: "boolean", flag: "no-resume" } },
        run: () => undefined,
      })
    ).toThrow(/--no-resume is a reserved flag/);
    expect(() =>
      defineCommand({
        params: { continueFresh: { type: "boolean", flag: "no-resume" } },
        run: () => undefined,
      })
    ).toThrow(/--no-resume is a reserved flag/);
  });

  it("throws at definition time if a param's derived name collides with --no-resume, with or without checkpoint configured", () => {
    expect(() =>
      defineCommand({
        checkpoint: { path: checkpointPath },
        params: { noResume: { type: "boolean" } },
        run: () => undefined,
      })
    ).toThrow(/--no-resume is a reserved flag/);
    expect(() =>
      defineCommand({
        params: { noResume: { type: "boolean" } },
        run: () => undefined,
      })
    ).toThrow(/--no-resume is a reserved flag/);
  });

  it("does not clear the checkpoint after a successful dry run", async () => {
    seedCheckpoint();
    const command = defineCommand({
      checkpoint: { path: checkpointPath },
      params: {},
      run: () => undefined,
    });
    await command.run(["--resume", "--dry-run"]);
    expect(openCheckpoint(checkpointPath).has("a")).toBe(true);
  });

  it("does not destructively clear a pre-existing checkpoint on a fresh (non-resume) dry run", async () => {
    seedCheckpoint();
    const command = defineCommand({
      checkpoint: { path: checkpointPath },
      params: {},
      run: () => undefined,
    });
    await command.run(["--dry-run"]);
    expect(openCheckpoint(checkpointPath).has("a")).toBe(true);
  });

  it("previews an empty checkpoint on a fresh (non-resume) dry run, even though the file survives on disk", async () => {
    seedCheckpoint();
    let seenHasA: boolean | undefined;
    let seenEntriesSize: number | undefined;
    const command = defineCommand({
      checkpoint: { path: checkpointPath },
      params: {},
      run: (_v, context) => {
        seenHasA = context.checkpoint?.has("a");
        seenEntriesSize = context.checkpoint?.entries().size;
      },
    });
    await command.run(["--dry-run"]);
    expect(seenHasA).toBe(false);
    expect(seenEntriesSize).toBe(0);
    // The on-disk file is untouched by the dry run (verified by the test above); this test
    // only asserts what `run` observes through `context.checkpoint`.
    expect(openCheckpoint(checkpointPath).has("a")).toBe(true);
  });

  it("never writes to disk when run records and flushes during a fresh dry run with no existing checkpoint", async () => {
    const command = defineCommand({
      checkpoint: { path: checkpointPath },
      params: {},
      run: (_v, context) => {
        context.checkpoint?.record("b");
        context.checkpoint?.flush();
      },
    });
    await command.run(["--dry-run"]);
    expect(fs.existsSync(checkpointPath)).toBe(false);
  });

  it("never writes to disk when run records and flushes during a --resume dry run", async () => {
    seedCheckpoint();
    let seenHasB: boolean | undefined;
    const command = defineCommand({
      checkpoint: { path: checkpointPath },
      params: {},
      run: (_v, context) => {
        context.checkpoint?.record("b");
        context.checkpoint?.flush();
        seenHasB = context.checkpoint?.has("b");
      },
    });
    await command.run(["--resume", "--dry-run"]);
    expect(seenHasB).toBe(true);
    expect(openCheckpoint(checkpointPath).has("b")).toBe(false);
  });

  it("never writes to disk when run records and flushes during a fresh dry run with an existing checkpoint", async () => {
    seedCheckpoint();
    const command = defineCommand({
      checkpoint: { path: checkpointPath },
      params: {},
      run: (_v, context) => {
        context.checkpoint?.record("b");
        context.checkpoint?.flush();
      },
    });
    await command.run(["--dry-run"]);
    const onDisk = openCheckpoint(checkpointPath);
    expect(onDisk.has("a")).toBe(true);
    expect(onDisk.has("b")).toBe(false);
  });

  it("clears the checkpoint after success by default", async () => {
    seedCheckpoint();
    const command = defineCommand({
      checkpoint: { path: checkpointPath },
      params: {},
      run: () => undefined,
    });
    await command.run(["--resume"]);
    expect(fs.existsSync(checkpointPath)).toBe(false);
  });

  it("leaves the checkpoint alone after success when clearOnSuccess is false", async () => {
    seedCheckpoint();
    const command = defineCommand({
      checkpoint: { path: checkpointPath, clearOnSuccess: false },
      params: {},
      run: () => undefined,
    });
    await command.run(["--resume"]);
    expect(openCheckpoint(checkpointPath).has("a")).toBe(true);
  });

  it("respects a caller-provided context.checkpoint override instead of opening the real file", async () => {
    const stub: CheckpointStore = {
      has: vi.fn(() => true),
      record: vi.fn(),
      entries: vi.fn(() => new Map()),
      flush: vi.fn(),
      clear: vi.fn(),
    };
    let received: CheckpointStore | undefined;
    const command = defineCommand({
      checkpoint: { path: checkpointPath },
      params: {},
      run: (_v, context) => {
        received = context.checkpoint;
      },
    });
    await command.run([], { checkpoint: stub });
    expect(received).toBe(stub);
    expect(fs.existsSync(checkpointPath)).toBe(false);
    expect(stub.clear).toHaveBeenCalledTimes(1);
  });

  function fakeStore(seed: Iterable<[string, unknown]> = []): CheckpointStore {
    const entries = new Map(seed);
    return {
      has: (key) => entries.has(key),
      record: vi.fn((key, meta) => entries.set(key, meta)),
      entries: () => entries,
      flush: vi.fn(),
      clear: vi.fn(() => entries.clear()),
    };
  }

  it("clears a caller-provided checkpoint override on a fresh, non-dry-run run, same as a path-backed store", async () => {
    const stub = fakeStore([["a", undefined]]);
    let seenHasA: boolean | undefined;
    const command = defineCommand({
      checkpoint: { path: checkpointPath },
      params: {},
      run: (_v, context) => {
        seenHasA = context.checkpoint?.has("a");
      },
    });
    await command.run([], { checkpoint: stub });
    expect(seenHasA).toBe(false);
    expect(stub.clear).toHaveBeenCalled();
    expect(fs.existsSync(checkpointPath)).toBe(false);
  });

  it("wraps a caller-provided checkpoint override in an in-memory view on a dry run", async () => {
    const stub = fakeStore([["a", undefined]]);
    let seenHasA: boolean | undefined;
    const command = defineCommand({
      checkpoint: { path: checkpointPath },
      params: {},
      run: (_v, context) => {
        context.checkpoint?.record("b");
        context.checkpoint?.flush();
        seenHasA = context.checkpoint?.has("a");
      },
    });
    await command.run(["--resume", "--dry-run"], { checkpoint: stub });
    // The dry-run preview still reflects the caller's real entries...
    expect(seenHasA).toBe(true);
    // ...but nothing `run` writes reaches the caller's actual store.
    expect(stub.record).not.toHaveBeenCalled();
    expect(stub.flush).not.toHaveBeenCalled();
    expect(stub.has("b")).toBe(false);
  });

  it("never touches the checkpoint file on --help or invalid args", async () => {
    seedCheckpoint();
    const run = vi.fn();
    const command = defineCommand({
      checkpoint: { path: checkpointPath },
      params: { limit: { type: "number" } },
      run,
    });
    await expect(command.run(["--help"])).rejects.toBeInstanceOf(CliHelpRequested);
    await expect(command.run(["--limit", "abc"])).rejects.toBeInstanceOf(CliValidationError);
    expect(run).not.toHaveBeenCalled();
    expect(openCheckpoint(checkpointPath).has("a")).toBe(true);
  });

  it("main(): a thrown error from run leaves the checkpoint untouched", async () => {
    seedCheckpoint();
    const log = testLog();
    const command = defineCommand({
      checkpoint: { path: checkpointPath },
      params: {},
      run: () => {
        throw new Error("boom");
      },
    });
    await command.main(["--resume"], { log });
    expect(process.exitCode).toBe(1);
    expect(openCheckpoint(checkpointPath).has("a")).toBe(true);
    process.exitCode = undefined;
  });

  it("main(): preserves a resumed checkpoint when SIGINT cleanup returns normally", async () => {
    seedCheckpoint();
    const log = testLog();
    let resolveStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    const onceSpy = vi.spyOn(process, "once");
    const previousExitCode = process.exitCode;
    const command = defineCommand({
      checkpoint: { path: checkpointPath },
      params: {},
      run: async (_v, context) => {
        resolveStarted?.();
        await new Promise<void>((resolve) => {
          context.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        context.checkpoint?.record("b");
        context.checkpoint?.flush();
      },
    });

    try {
      const runPromise = command.main(["--resume"], { log });
      await started;
      const registration = onceSpy.mock.calls.find(([event]) => event === "SIGINT");
      expect(registration).toBeDefined();
      (registration?.[1] as () => void)();
      await runPromise;

      expect(process.exitCode).toBe(130);
      expect(openCheckpoint(checkpointPath).has("a")).toBe(true);
      expect(openCheckpoint(checkpointPath).has("b")).toBe(true);
    } finally {
      process.exitCode = previousExitCode;
      onceSpy.mockRestore();
    }
  });

  it("lists --resume in help for every command, checkpoint or not", () => {
    const withCheckpoint = defineCommand({
      checkpoint: { path: checkpointPath },
      params: {},
      run: () => undefined,
    });
    const withoutCheckpoint = defineCommand({ params: {}, run: () => undefined });
    const withResult = withCheckpoint.parse(["--help"]);
    const withoutResult = withoutCheckpoint.parse(["--help"]);
    expect(withResult.kind === "help" && withResult.helpText).toContain("--resume");
    expect(withoutResult.kind === "help" && withoutResult.helpText).toContain("--resume");
  });

  it("parses --resume/--no-resume into a typed values.resume even without checkpoint configured", () => {
    const command = defineCommand({ params: {}, run: (v) => v });
    expect(command.parse([])).toMatchObject({ kind: "values", values: { resume: false } });
    expect(command.parse(["--resume"])).toMatchObject({
      kind: "values",
      values: { resume: true },
    });
    expect(command.parse(["--no-resume"])).toMatchObject({
      kind: "values",
      values: { resume: false },
    });
  });
});

describe("defineCommand.run", () => {
  it("parses and calls run, returning its result", async () => {
    const command = defineCommand({
      params: { limit: { type: "number", default: 5 } },
      run: (values) => values.limit * 2,
    });
    await expect(command.run(["--limit", "10"])).resolves.toBe(20);
  });

  it("throws CliValidationError instead of calling run on bad args", async () => {
    const run = vi.fn();
    const command = defineCommand({ params: { limit: { type: "number" } }, run });
    await expect(command.run(["--limit", "abc"])).rejects.toBeInstanceOf(CliValidationError);
    expect(run).not.toHaveBeenCalled();
  });

  it("throws CliHelpRequested instead of calling run on --help", async () => {
    const run = vi.fn();
    const command = defineCommand({ params: {}, run });
    await expect(command.run(["--help"])).rejects.toBeInstanceOf(CliHelpRequested);
    expect(run).not.toHaveBeenCalled();
  });
});

describe("defineCommand.main", () => {
  const originalExitCode = process.exitCode;

  afterEach(() => {
    process.exitCode = originalExitCode;
  });

  it("runs the command and leaves the exit code untouched on success", async () => {
    process.exitCode = undefined;
    const command = defineCommand({
      params: { limit: { type: "number", default: 5 } },
      run: vi.fn(),
    });
    await command.main(["--limit", "10"]);
    expect(process.exitCode).toBeUndefined();
  });

  it("prints errors and the help text, and sets exit code 1, without throwing", async () => {
    const log = testLog();
    const command = defineCommand({ params: { limit: { type: "number" } }, run: vi.fn() });
    await command.main(["--limit", "abc"], { log });
    expect(process.exitCode).toBe(1);
    expect(
      log.lines.some((l) => l.level === "error" && l.message.includes("must be a number"))
    ).toBe(true);
    expect(log.lines.some((l) => l.message.includes("Usage:"))).toBe(true);
  });

  it("prints help and sets exit code 0 on --help", async () => {
    const log = testLog();
    const command = defineCommand({ params: {}, run: vi.fn() });
    await command.main(["--help"], { log });
    expect(process.exitCode).toBe(0);
    expect(log.lines.some((l) => l.message.includes("Usage:"))).toBe(true);
  });

  it("catches a thrown error from run and sets exit code 1", async () => {
    const log = testLog();
    const command = defineCommand({
      params: {},
      run: () => {
        throw new Error("boom");
      },
    });
    await command.main([], { log });
    expect(process.exitCode).toBe(1);
    expect(log.lines.some((l) => l.level === "error" && l.message.includes("boom"))).toBe(true);
  });
});
