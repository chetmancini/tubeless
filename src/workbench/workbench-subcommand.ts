import {
  errorMessage,
  TUBELESS_WORKBENCH_EXIT_CODE,
  writeUsageError,
  type WorkbenchCliIo,
} from "./workbench-shared.js";

/**
 * Shared prologue for workbench subcommands. New subcommands should be written
 * against `runWorkbenchSubcommand` so usage, help, and positional checks stay
 * in one place. Extra validation after that prologue belongs in `run`.
 */
export interface WorkbenchSubcommand<TParsed> {
  readonly usage: string;
  parse(argv: readonly string[]): TParsed;
  helpRequested(parsed: TParsed): boolean;
  positionals(parsed: TParsed): readonly string[];
  readonly positionalCountError?: { count: number; message: string };
  run(parsed: TParsed, io: WorkbenchCliIo): Promise<number>;
}

export async function runWorkbenchSubcommand<TParsed>(
  command: WorkbenchSubcommand<TParsed>,
  argv: readonly string[],
  io: WorkbenchCliIo
): Promise<number> {
  let parsed: TParsed;
  try {
    parsed = command.parse(argv);
  } catch (error) {
    return writeUsageError(io, errorMessage(error), command.usage);
  }
  if (command.helpRequested(parsed)) {
    io.stdout.write(command.usage);
    return TUBELESS_WORKBENCH_EXIT_CODE.success;
  }
  const positionalError = command.positionalCountError;
  if (positionalError && command.positionals(parsed).length !== positionalError.count) {
    return writeUsageError(io, positionalError.message, command.usage);
  }
  return command.run(parsed, io);
}
