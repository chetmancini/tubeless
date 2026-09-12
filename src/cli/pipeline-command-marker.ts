const PIPELINE_COMMAND_MARKER = Symbol.for("tubeless/pipeline-command");

/** Mark only commands created by definePipelineCommand as workbench-executable. */
export function markPipelineCommand<T extends object>(command: T): T {
  Object.defineProperty(command, PIPELINE_COMMAND_MARKER, {
    configurable: false,
    enumerable: false,
    value: true,
    writable: false,
  });
  return command;
}

/** Recognize a pipeline command across duplicate package instances in a loaded module. */
export function isMarkedPipelineCommand(value: unknown): boolean {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    // SAFETY: value is a non-null object/function here, so symbol-keyed property
    // access never throws. The marker is only ever written as the literal `true`
    // by markPipelineCommand, so a strict `=== true` comparison is reliable.
    (value as { [PIPELINE_COMMAND_MARKER]?: boolean })[PIPELINE_COMMAND_MARKER] === true
  );
}
