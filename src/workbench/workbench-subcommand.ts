import { parseArgs, type ParseArgsConfig } from "node:util";
import { didYouMean } from "../utilities/suggest.js";
import {
  errorMessage,
  TUBELESS_WORKBENCH_EXIT_CODE,
  writeUsageError,
  type WorkbenchCliIo,
} from "./workbench-shared.js";

type SubcommandOptions = NonNullable<ParseArgsConfig["options"]>;

export type WorkbenchCompletionValue = "file" | "text" | "target" | "step" | readonly string[];

export type WorkbenchOption = {
  readonly description: string;
  readonly short?: string;
  /** Nested commands accepting this option; omitted means all commands. */
  readonly commands?: readonly string[];
} & (
  | {
      readonly type: "boolean";
      readonly multiple?: never;
      readonly valueName?: never;
      readonly completion?: never;
    }
  | {
      readonly type: "string";
      readonly multiple?: boolean;
      readonly valueName: string;
      readonly completion?: WorkbenchCompletionValue;
    }
);

export interface WorkbenchCommandSpec {
  readonly name: string;
  readonly usage: string;
  readonly footer?: string;
  readonly options: Readonly<Record<string, WorkbenchOption>>;
  readonly positional?: "pipeline" | "file" | readonly string[];
  readonly subcommands?: readonly string[];
  readonly passthrough?: boolean;
}

const HELP_OPTION = { type: "boolean", short: "h", description: "Show this help" } as const;

/** Options visible at the root, or accepted by one selected nested command. */
export function workbenchOptions(
  spec: WorkbenchCommandSpec,
  command?: string
): Readonly<Record<string, WorkbenchOption>> {
  const selected = spec.subcommands?.some((name) => name === command) === true;
  return Object.fromEntries([
    ...Object.entries(spec.options).filter(
      ([, option]) =>
        !selected || !option.commands || option.commands.some((name) => name === command)
    ),
    ["help", HELP_OPTION],
  ]);
}

export function renderWorkbenchUsage(spec: WorkbenchCommandSpec, command?: string): string {
  const rows = Object.entries(workbenchOptions(spec, command)).map(([name, option]) => ({
    flag: `${option.short ? `-${option.short}, ` : "    "}--${name}${option.valueName ? ` <${option.valueName}>` : ""}`,
    description: option.description,
  }));
  const width = Math.max(...rows.map(({ flag }) => flag.length));
  return `${spec.usage.trimEnd()}\n\nOptions:\n${rows.map(({ flag, description }) => `  ${flag.padEnd(width)}  ${description}`).join("\n")}\n${spec.footer ? `\n${spec.footer.trimEnd()}\n` : ""}`;
}

/** Strict subcommand parsing with positionals; every subcommand accepts `-h, --help`. */
export function parseSubcommandArgs<const T extends SubcommandOptions>(
  argv: readonly string[],
  options: T
) {
  return parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: { ...options, help: HELP_OPTION } as const,
    strict: true,
  });
}

interface ParsedSubcommand {
  values: { help?: boolean };
  positionals: readonly string[];
}

/**
 * Shared prologue for workbench subcommands. New subcommands should be written
 * against `runWorkbenchSubcommand` so usage, help, and positional checks stay
 * in one place. Extra validation after that prologue belongs in `run`.
 */
export interface WorkbenchSubcommand<TParsed extends ParsedSubcommand> {
  readonly spec: WorkbenchCommandSpec;
  parse(argv: readonly string[]): TParsed;
  readonly positionalCountError?: { count: number; message: string };
  run(parsed: TParsed, io: WorkbenchCliIo): Promise<number>;
}

export async function runWorkbenchSubcommand<TParsed extends ParsedSubcommand>(
  command: WorkbenchSubcommand<TParsed>,
  argv: readonly string[],
  io: WorkbenchCliIo
): Promise<number> {
  let parsed: TParsed;
  try {
    parsed = command.parse(argv);
  } catch (error) {
    return writeUsageError(
      io,
      parseErrorMessage(error, command.spec),
      renderWorkbenchUsage(command.spec)
    );
  }
  const usage = renderWorkbenchUsage(command.spec, parsed.positionals[0]);
  if (parsed.values.help === true) {
    io.stdout.write(usage);
    return TUBELESS_WORKBENCH_EXIT_CODE.success;
  }
  const positionalError = command.positionalCountError;
  if (positionalError && parsed.positionals.length !== positionalError.count) {
    return writeUsageError(io, positionalError.message, usage);
  }
  const options = workbenchOptions(command.spec, parsed.positionals[0]);
  for (const key of Object.keys(parsed.values)) {
    if (!Object.hasOwn(options, key)) {
      return writeUsageError(
        io,
        `--${key} is not supported by ${command.spec.name} ${parsed.positionals[0]}.`,
        usage
      );
    }
  }
  return command.run(parsed, io);
}

/**
 * `node:util` `parseArgs` rejects unknown flags with a verbose message naming the
 * offending token. Report it in the same shape as pipeline commands. The usage
 * metadata supplies the accepted long flags for near-miss suggestions.
 */
function parseErrorMessage(error: unknown, spec: WorkbenchCommandSpec): string {
  const message = errorMessage(error);
  if ((error as { code?: unknown } | null)?.code !== "ERR_PARSE_ARGS_UNKNOWN_OPTION") {
    return message;
  }
  const token = /^Unknown option '([^']+)'/.exec(message)?.[1];
  if (token === undefined) return message;
  const unknown = `Unknown option: ${token}.`;
  if (!token.startsWith("--")) return unknown;
  const flags = Object.keys(workbenchOptions(spec)).map((name) => `--${name}`);
  const suggestion = didYouMean(token.split("=", 1)[0], flags, (candidate) => candidate);
  return suggestion === undefined ? unknown : `${unknown} ${suggestion}`;
}
