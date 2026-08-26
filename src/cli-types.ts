import type { CheckpointStore } from "./checkpoint.js";
import type { PipelineContext, PipelineLogger } from "./pipeline.js";

/**
 * Typed command-line entry points for scripts, mirroring how `definePipeline` turns a
 * declarative step list into a runnable pipeline: declare a flag schema once and get a
 * fully-typed, validated `values` object handed to `run`, instead of each script hand-
 * rolling its own `process.argv` scanning and `as` casts.
 */

export type CliParamType = "string" | "number" | "boolean" | "path";

interface CliParamBase {
  /** Shown next to the flag in generated `--help` output. */
  description?: string;
  /** Overrides the derived `--flag-name`; defaults to the kebab-case of the schema key. */
  flag?: string;
  /** Optional one-letter alias, for example `short: "v"` enables `-v`. */
  short?: string;
  /**
   * Optional environment-variable fallback. Explicit argv values always win;
   * the environment value is validated like argv but never echoed in errors.
   */
  env?: string;
}

export interface CliStringParam extends CliParamBase {
  type: "string";
  choices?: readonly string[];
  default?: string;
  optional?: boolean;
  /** Repeatable: `--flag a --flag b` accumulates into `readonly string[]`, `[]` when absent. Cannot combine with `default`. */
  multiple?: boolean;
}

export interface CliNumberParam extends CliParamBase {
  type: "number";
  default?: number;
  optional?: boolean;
  integer?: boolean;
  min?: number;
  max?: number;
  /** Repeatable: `--flag 1 --flag 2` accumulates into `readonly number[]`, `[]` when absent. Cannot combine with `default`. */
  multiple?: boolean;
}

export interface CliBooleanParam extends CliParamBase {
  type: "boolean";
  /** Defaults to `false`. A bare `--flag` sets `true`; `--no-flag` sets `false`. */
  default?: boolean;
}

export interface CliPathParam extends CliParamBase {
  type: "path";
  /** Relative defaults and values are resolved against `context.cwd`, like `definePaths`. */
  default?: string;
  optional?: boolean;
  /** Validates the resolved path exists before `run` is called. */
  mustExist?: boolean;
  /** Only checked when `mustExist` is true; asserts the resolved path's kind. */
  kind?: "file" | "directory";
}

export type CliParam = CliStringParam | CliNumberParam | CliBooleanParam | CliPathParam;

export type CliParamsSchema = Record<string, CliParam>;

/** JSON-safe description of one validated command parameter for non-terminal clients. */
export interface CliParameterDescriptor {
  readonly choices?: readonly string[];
  readonly default?: string | number | boolean;
  readonly description?: string;
  readonly environment?: string;
  readonly flag: string;
  readonly integer?: boolean;
  readonly key: string;
  readonly max?: number;
  readonly min?: number;
  readonly multiple: boolean;
  readonly mustExist?: boolean;
  readonly pathKind?: "directory" | "file";
  readonly positional: boolean;
  readonly required: boolean;
  readonly short?: string;
  readonly type: CliParamType;
}

/** Immutable, presentation-neutral command contract shared by CLI and UI adapters. */
export interface CliCommandDescriptor {
  readonly description?: string;
  readonly name: string;
  readonly parameters: readonly CliParameterDescriptor[];
}

type CliScalarStringValue<P extends CliParam> = P extends {
  choices: readonly (infer TChoice extends string)[];
}
  ? TChoice
  : string;

type CliParamValue<P extends CliParam> = P extends { type: "string" }
  ? P extends { multiple: true }
    ? readonly CliScalarStringValue<P>[]
    : CliScalarStringValue<P>
  : P extends { type: "number" }
    ? P extends { multiple: true }
      ? readonly number[]
      : number
    : P extends { type: "boolean" }
      ? boolean
      : P extends { type: "path" }
        ? string
        : never;

/**
 * A field is optional in the parsed output only when it's explicitly marked `optional:
 * true` (booleans never are — an absent boolean flag just means `false`). A field with a
 * `default` is also always present at runtime, but that's already covered: schemas
 * shouldn't combine `default` with `optional: true`, and if one does, the parsed type is
 * merely wider than necessary (`T | undefined` instead of `T`), never wrong.
 */
type CliParamIsOptional<P extends CliParam> = P extends { type: "boolean" }
  ? false
  : P extends { multiple: true }
    ? false
    : P extends { optional: true }
      ? true
      : false;

type RequiredCliParams<TSchema extends CliParamsSchema> = {
  [K in keyof TSchema as CliParamIsOptional<TSchema[K]> extends true ? never : K]: CliParamValue<
    TSchema[K]
  >;
};

type OptionalCliParams<TSchema extends CliParamsSchema> = {
  [K in keyof TSchema as CliParamIsOptional<TSchema[K]> extends true ? K : never]?: CliParamValue<
    TSchema[K]
  >;
};

/**
 * Every command's parsed values include `dryRun` and `resume`, whether or not `TSchema`
 * declares them. `resume` is `false` unless `--resume` is passed or `checkpoint.defaultResume`
 * is `true`; it's meaningful even without `checkpoint` configured — a command can implement
 * its own "is this done" check and just read `values.resume` directly.
 */
export type CliParams<TSchema extends CliParamsSchema> = {
  dryRun: boolean;
  resume: boolean;
} & RequiredCliParams<TSchema> &
  OptionalCliParams<TSchema>;

export interface CliContext {
  cwd: string;
  /** Environment used for `param.env` fallbacks. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  log: PipelineLogger;
  /** Optional executor-only context used when this command runs a pipeline. */
  pipelineContext?: Omit<PipelineContext, "cwd" | "log" | "signal">;
  /** Optional caller-owned cancellation signal forwarded to command work. */
  signal?: AbortSignal;
  /** Present whenever the command's `checkpoint` config is set; see `CliCheckpointConfig`. */
  checkpoint?: CheckpointStore;
}

export type CliParseResult<TSchema extends CliParamsSchema> =
  | { kind: "values"; values: CliParams<TSchema> }
  | { kind: "help"; helpText: string }
  | { kind: "error"; errors: readonly string[]; helpText: string };

export class CliValidationError extends Error {
  constructor(
    readonly errors: readonly string[],
    readonly helpText: string
  ) {
    super(`Invalid command-line arguments:\n${errors.map((error) => `  - ${error}`).join("\n")}`);
    this.name = "CliValidationError";
  }
}

export class CliHelpRequested extends Error {
  constructor(readonly helpText: string) {
    super(helpText);
    this.name = "CliHelpRequested";
  }
}

export interface CliCheckpointConfig {
  /** Relative paths resolve against `context.cwd`, like `CliPathParam`. */
  path: string;
  /**
   * Defaults to `true`: a fully successful, non-dry-run `run` clears the checkpoint —
   * the one-shot resumable-job pattern (start fresh next time). Set `false` for an
   * incrementally-growing "done" set (e.g. entity enrichment) that must never auto-clear,
   * since clearing it would cause already-processed items to be reprocessed.
   */
  clearOnSuccess?: boolean;
  /**
   * Defaults to `false`: start fresh unless `--resume` is passed. Set `true` to always
   * resume by default (skip already-recorded items every run); `--no-resume` is the free
   * opt-out, since boolean flags already support `--no-<flag>` negation.
   */
  defaultResume?: boolean;
}

export interface CliCommandConfig<TSchema extends CliParamsSchema, TResult> {
  /** Shown in generated usage text; defaults to the running script's file name. */
  name?: string;
  description?: string;
  /** `dryRun`/`--dry-run` and `-h`/`--help` are provided automatically; don't redeclare them. */
  params: TSchema;
  /**
   * Schema keys accepted in positional order. Flags for an earlier positional
   * let the next positional fill the next unset field; a repeatable positional
   * must be last.
   */
  positionals?: readonly (keyof TSchema & string)[];
  /**
   * Opts into a managed checkpoint file. Adds a reserved `--resume`/`--no-resume` flag
   * (also don't redeclare a `resume` param) and populates `context.checkpoint` before
   * `run` is called: resolved fresh (existing file cleared) unless resuming, and cleared
   * again after a successful non-dry-run unless `clearOnSuccess` is `false`.
   */
  checkpoint?: CliCheckpointConfig;
  /** Runs after every field passes its own validation; return error messages to reject. */
  validate?(values: CliParams<TSchema>, context: CliContext): string[] | void;
  run(values: CliParams<TSchema>, context: CliContext): TResult | Promise<TResult>;
}

export interface CliCommand<TSchema extends CliParamsSchema, TResult> {
  /** Structured schema metadata for adapters that should not parse generated help text. */
  readonly descriptor: CliCommandDescriptor;
  /** Pure: parses and validates without calling `run` or touching the process. */
  parse(argv?: readonly string[], context?: Partial<CliContext>): CliParseResult<TSchema>;
  /** Validates structured parameter values without tokenizing command-line arguments. */
  parseValues(
    values: Record<string, unknown>,
    context?: Partial<CliContext>
  ): CliParseResult<TSchema>;
  /** Calls `run` from already validated parameter values. */
  execute(values: CliParams<TSchema>, context?: Partial<CliContext>): Promise<TResult>;
  /** Parses and calls `run`; throws `CliValidationError`/`CliHelpRequested` instead of running it. */
  run(argv?: readonly string[], context?: Partial<CliContext>): Promise<TResult>;
  /**
   * Entry point for `if (import.meta.main) void command.main();`. Prints help/errors and
   * sets `process.exitCode` — never calls `process.exit`, so buffered output still flushes
   * — instead of throwing.
   */
  main(argv?: readonly string[], context?: Partial<CliContext>): Promise<void>;
}
