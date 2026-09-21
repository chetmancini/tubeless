const PIPELINE_COMMAND_MARKER = Symbol.for("tubeless/pipeline-command");

/** Associate a command with the exact pipeline it adapts, without a CLI runtime dependency. */
export function markPipelineCommand<T extends object>(command: T, pipeline: object): T {
  Object.defineProperty(command, PIPELINE_COMMAND_MARKER, { value: pipeline });
  return command;
}

/** Recover the pipeline across duplicate package instances in a loaded module. */
export function pipelineForCommand(value: unknown): object | undefined {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) {
    return undefined;
  }
  // SAFETY: value is a non-null object/function; validate its symbol-keyed metadata below.
  const pipeline = (value as { [PIPELINE_COMMAND_MARKER]?: unknown })[PIPELINE_COMMAND_MARKER];
  return typeof pipeline === "object" && pipeline !== null ? pipeline : undefined;
}
