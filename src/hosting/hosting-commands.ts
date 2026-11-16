import type { CliCommandDescriptor, CliContext } from "../cli/cli.js";
import { definePipelineCommand, type PipelineCommand } from "../cli/cli-pipeline-command.js";
import {
  cliValidationReportLines,
  isCliHelpRequested,
  isCliValidationError,
  isPipelineExecutionError,
  toExitCode,
  TUBELESS_WORKBENCH_EXIT_CODE,
} from "../cli/cli-exit.js";
import type {
  Pipeline,
  PipelineContext,
  PipelinePlan,
  PipelineRunControls,
} from "../core/pipeline.js";
import { causalPipelineErrors } from "../core/pipeline-diagnostics.js";
import type {
  AnyProjectPipeline,
  PipelineProject,
  ProjectOptions,
} from "../project/pipeline-project.js";
import { renderPipelineError } from "../render/render.js";
import type { PipelineRunStudioCommand } from "../studio/shared/protocol.js";
import { isAbortError } from "../utilities/abort.js";
import { pipelineForCommand } from "../utilities/pipeline-command-marker.js";

export type HostedParseResult =
  | { kind: "values"; values: Record<string, unknown> }
  | { kind: "help"; helpText: string }
  | { kind: "error"; errors: readonly string[]; helpText: string };

/** Runtime surface of a definePipelineCommand result needed to host it. */
export interface HostedPipelineCommand {
  readonly id: string;
  readonly descriptor: CliCommandDescriptor;
  parseValues(values: Record<string, unknown>, context?: Partial<CliContext>): HostedParseResult;
  execute(values: Record<string, unknown>, context?: Partial<CliContext>): Promise<unknown>;
  plan(controls?: PipelineRunControls): PipelinePlan;
}

export interface HostedOutput {
  readonly cwd: string;
  readonly stdout: { write(chunk: string): boolean | void };
  readonly stderr: { write(chunk: string): boolean | void };
}

export interface HostedCommand {
  readonly tracing?: ProjectOptions["tracing"];
  readonly descriptor: PipelineRunStudioCommand;
  readonly command: HostedPipelineCommand;
}

/** Validate one owned submission and expose only declared command parameters. */
export function parseHostedLaunch(
  entry: HostedCommand | undefined,
  values: Record<string, unknown>,
  output: HostedOutput
): { values: Record<string, unknown> } | { errors: readonly string[] } {
  if (!entry) return { errors: ["Pipeline command not found."] };
  let parsed: HostedParseResult;
  try {
    parsed = entry.command.parseValues(
      values,
      hostedCommandContext(output, new AbortController().signal)
    );
  } catch (error) {
    return { errors: [error instanceof Error ? error.message : String(error)] };
  }
  if (parsed.kind === "error") return { errors: parsed.errors };
  if (parsed.kind === "help") return { errors: ["Help is not a launchable value set."] };
  // CLI parsing also produces internal values such as unsupported resume=false.
  // Only descriptor parameters can be passed back through structured command input.
  const resolved = parsed.values;
  return {
    values: Object.fromEntries(
      entry.descriptor.parameters
        .filter((parameter) => resolved[parameter.key] !== undefined)
        .map((parameter) => [parameter.key, resolved[parameter.key]])
    ),
  };
}

function isHostedPipelineCommand(value: unknown): value is HostedPipelineCommand {
  if (!pipelineForCommand(value)) return false;
  const candidate = value as object;
  return (
    "id" in candidate &&
    typeof candidate.id === "string" &&
    "descriptor" in candidate &&
    typeof candidate.descriptor === "object" &&
    candidate.descriptor !== null &&
    "parseValues" in candidate &&
    typeof candidate.parseValues === "function" &&
    "execute" in candidate &&
    typeof candidate.execute === "function" &&
    "plan" in candidate &&
    typeof candidate.plan === "function"
  );
}

/** Pipeline surface available before proving that a loaded module can also run. */
export type HostablePipeline = Pick<
  Pipeline<object, unknown>,
  "id" | "stepIds" | "targetIds" | "plan" | "toMermaid"
>;

function isExecutablePipeline(pipeline: HostablePipeline): pipeline is Pipeline<object, unknown> {
  return (
    "run" in pipeline &&
    typeof pipeline.run === "function" &&
    "runOrThrow" in pipeline &&
    typeof pipeline.runOrThrow === "function"
  );
}

export function commandForPipeline(
  pipeline: HostablePipeline,
  source: "directly loaded" | "project"
): HostedPipelineCommand & PipelineCommand<{}, unknown> {
  if (!isExecutablePipeline(pipeline)) {
    throw new Error("The selected pipeline does not expose executable run methods.");
  }
  // A missing runtime schema cannot prove that the erased pipeline input is empty.
  if (pipeline.optionsSchema === undefined) {
    const adapterLocation =
      source === "project"
        ? "register a definePipelineCommand with explicit params in the project entry list"
        : "export a definePipelineCommand with explicit params";
    throw new Error(
      `Automatic commands require Standard JSON Schema input metadata. Use createSteps(schema), or ${adapterLocation}.`
    );
  }
  return definePipelineCommand(pipeline);
}

export function studioDescriptor(command: HostedPipelineCommand): PipelineRunStudioCommand {
  const descriptor: PipelineRunStudioCommand = {
    canPlan: true,
    id: command.id,
    name: command.descriptor.name,
    parameters: command.descriptor.parameters,
  };
  if (command.descriptor.description !== undefined) {
    descriptor.description = command.descriptor.description;
  }
  return descriptor;
}

export function hostedProjectCommands(
  project: PipelineProject<string, readonly AnyProjectPipeline[]>
): readonly HostedCommand[] {
  const explicit = new Map<string, HostedPipelineCommand>();
  for (const command of project.commands) {
    if (!isHostedPipelineCommand(command)) {
      throw new Error("Project commands must be created with definePipelineCommand.");
    }
    explicit.set(command.id, command);
  }
  const seen = new Set<string>();
  return project.pipelines.map((pipeline) => {
    let command: HostedPipelineCommand;
    try {
      command = explicit.get(pipeline.id) ?? commandForPipeline(pipeline, "project");
    } catch (error) {
      throw new Error(
        `Cannot derive a command for project pipeline ${JSON.stringify(pipeline.id)}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    if (seen.has(command.id)) {
      throw new Error(`Studio command id ${JSON.stringify(command.id)} is duplicated.`);
    }
    seen.add(command.id);
    return { command, descriptor: studioDescriptor(command), tracing: project.tracing };
  });
}

function writeCommandLine(
  output: HostedOutput["stdout"] | HostedOutput["stderr"],
  message: string,
  ...optionalParams: string[]
): void {
  output.write(`${[message, ...optionalParams].join(" ")}\n`);
}

export function hostedCommandContext(
  output: HostedOutput,
  signal: AbortSignal,
  pipelineContext?: Omit<PipelineContext, "cwd" | "log" | "signal">
): CliContext {
  const context: CliContext = {
    cwd: output.cwd,
    log: {
      error: (message, ...params) =>
        writeCommandLine(
          output.stderr,
          String(message ?? ""),
          ...params.map((param) => String(param ?? ""))
        ),
      log: (message, ...params) =>
        writeCommandLine(
          output.stdout,
          String(message ?? ""),
          ...params.map((param) => String(param ?? ""))
        ),
      warn: (message, ...params) =>
        writeCommandLine(
          output.stderr,
          String(message ?? ""),
          ...params.map((param) => String(param ?? ""))
        ),
    },
    reporterOutput: output.stdout,
    signal,
  };
  if (pipelineContext) context.pipelineContext = pipelineContext;
  return context;
}

export async function executeHostedCommandOperation(
  operation: () => Promise<void>,
  output: HostedOutput,
  signal: AbortSignal
): Promise<number> {
  try {
    await operation();
    return signal.aborted
      ? TUBELESS_WORKBENCH_EXIT_CODE.cancellation
      : TUBELESS_WORKBENCH_EXIT_CODE.success;
  } catch (error) {
    if (isCliHelpRequested(error)) {
      output.stdout.write(`${error.helpText.replace(/\n+$/, "")}\n`);
      return toExitCode(error);
    }
    if (isCliValidationError(error)) {
      output.stderr.write(`${cliValidationReportLines(error.errors, error.helpText).join("\n")}\n`);
      return toExitCode(error);
    }
    if (isPipelineExecutionError(error)) {
      for (const pipelineError of causalPipelineErrors(error.result)) {
        output.stderr.write(`Error: ${renderPipelineError(pipelineError)}\n`);
      }
      return toExitCode(error);
    }
    if (signal.aborted && isAbortError(error)) {
      return TUBELESS_WORKBENCH_EXIT_CODE.cancellation;
    }
    output.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
    return toExitCode(error);
  }
}

export async function executeHostedCommand(
  command: Pick<HostedPipelineCommand, "execute">,
  values: Record<string, unknown>,
  output: HostedOutput,
  signal: AbortSignal,
  pipelineContext?: Omit<PipelineContext, "cwd" | "log" | "signal">
): Promise<number> {
  return executeHostedCommandOperation(
    async () => {
      await command.execute(values, hostedCommandContext(output, signal, pipelineContext));
    },
    output,
    signal
  );
}
