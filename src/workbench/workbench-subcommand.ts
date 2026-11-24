import { parseArgs } from "node:util";
import { didYouMean } from "../utilities/suggest.js";
import {
  errorMessage,
  TUBELESS_WORKBENCH_EXIT_CODE,
  writeUsageError,
  type WorkbenchCliIo,
} from "./workbench-shared.js";

type SubcommandOptions = Readonly<Record<string, WorkbenchOption>>;

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

export interface WorkbenchCommandSpec<TOptions extends SubcommandOptions = SubcommandOptions> {
  readonly name: string;
  readonly usage: string;
  readonly footer?: string;
  readonly options: TOptions;
  readonly positional?: {
    readonly min?: number;
    readonly max: number;
    readonly error: string;
    readonly completion?: "pipeline" | "file" | readonly string[];
  };
  readonly subcommands?: readonly string[];
  readonly defaultSubcommand?: string;
  readonly subcommandPositionals?: Readonly<Record<string, "file">>;
  readonly passthrough?: boolean;
}

const HELP_OPTION = { type: "boolean", short: "h", description: "Show this help" } as const;

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

export function parseSubcommandArgs<const TOptions extends SubcommandOptions>(
  argv: readonly string[],
  spec: WorkbenchCommandSpec<TOptions>
) {
  const separator = spec.passthrough ? argv.indexOf("--") : -1;
  return {
    ...parseArgs({
      args: separator === -1 ? [...argv] : argv.slice(0, separator),
      allowPositionals: true,
      options: { ...spec.options, help: HELP_OPTION } as const,
      strict: true,
    }),
    commandArgs: separator === -1 ? [] : argv.slice(separator + 1),
  };
}

export type ParsedSubcommand<TOptions extends SubcommandOptions> = ReturnType<
  typeof parseSubcommandArgs<TOptions>
>;

interface WorkbenchSubcommand<TOptions extends SubcommandOptions> {
  readonly spec: WorkbenchCommandSpec<TOptions>;
  run(parsed: ParsedSubcommand<TOptions>, io: WorkbenchCliIo): Promise<number>;
}

export async function runWorkbenchSubcommand<const TOptions extends SubcommandOptions>(
  command: WorkbenchSubcommand<TOptions>,
  argv: readonly string[],
  io: WorkbenchCliIo
): Promise<number> {
  let parsed: ParsedSubcommand<TOptions>;
  try {
    parsed = parseSubcommandArgs(argv, command.spec);
  } catch (error) {
    return writeUsageError(
      io,
      parseErrorMessage(error, command.spec),
      renderWorkbenchUsage(command.spec)
    );
  }
  const usage = renderWorkbenchUsage(command.spec, parsed.positionals[0]);
  if ("help" in parsed.values && parsed.values.help === true) {
    io.stdout.write(usage);
    return TUBELESS_WORKBENCH_EXIT_CODE.success;
  }
  const positional = command.spec.positional;
  if (
    positional &&
    (parsed.positionals.length < (positional.min ?? 0) ||
      parsed.positionals.length > positional.max)
  ) {
    return writeUsageError(io, positional.error, usage);
  }
  const selected = parsed.positionals[0] ?? command.spec.defaultSubcommand;
  const options = workbenchOptions(command.spec, selected);
  for (const key of Object.keys(parsed.values)) {
    if (!Object.hasOwn(options, key)) {
      return writeUsageError(
        io,
        `--${key} is not supported by ${command.spec.name} ${selected}.`,
        renderWorkbenchUsage(command.spec, selected)
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
