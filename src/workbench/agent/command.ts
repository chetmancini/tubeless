import { WORKBENCH_SPECS } from "../workbench-command-specs.js";
import {
  renderWorkbenchUsage,
  parseSubcommandArgs,
  runWorkbenchSubcommand,
} from "../workbench-subcommand.js";
import type { AgentLimits, DefaultAgentToolName } from "../../agent/agent.js";
import { loadAgentEnvironment } from "./environment.js";
import { loadAgentProvider } from "./provider.js";
import { runAgentSession } from "./session.js";
import { toExitCode } from "../../cli/cli-exit.js";
import { composeTraceExporters } from "../../tracing/tracing.js";
import {
  openWorkbenchRecording,
  recordingDestinationsConflict,
  type WorkbenchRecording,
} from "../workbench-recording.js";
import {
  errorMessage,
  TUBELESS_WORKBENCH_EXIT_CODE,
  writeUsageError,
  type WorkbenchCliIo,
} from "../workbench-shared.js";

const AGENT_USAGE = renderWorkbenchUsage(WORKBENCH_SPECS.agent);
const DEFAULT_TOOLS: readonly DefaultAgentToolName[] = [
  "read",
  "write",
  "edit",
  "bash",
  "list",
  "search",
];
const isDefaultTool = (name: string): name is DefaultAgentToolName =>
  (DEFAULT_TOOLS as readonly string[]).includes(name);

export function runAgent(argv: readonly string[], io: WorkbenchCliIo): Promise<number> {
  return runWorkbenchSubcommand(
    {
      spec: WORKBENCH_SPECS.agent,
      parse: (args) => parseSubcommandArgs(args, WORKBENCH_SPECS.agent.options),
      positionalCountError: {
        count: 0,
        message: "Use --prompt for a task or start the REPL without positional arguments.",
      },
      async run({ values }, io) {
        if (values.provider !== undefined && !values.provider.trim())
          return writeUsageError(io, "Provider name must not be blank.", AGENT_USAGE);
        if (values["model-module"] !== undefined && !values["model-module"].trim())
          return writeUsageError(io, "Model module must not be blank.", AGENT_USAGE);
        if (values.model !== undefined && !values.model.trim())
          return writeUsageError(io, "Model name must not be blank.", AGENT_USAGE);
        if (values.prompt !== undefined && !values.prompt.trim())
          return writeUsageError(io, "Prompt must not be blank.", AGENT_USAGE);
        if (values["env-file"] !== undefined && !values["env-file"].trim())
          return writeUsageError(io, "Environment file must not be blank.", AGENT_USAGE);
        const limits: AgentLimits = {
          maxTurns: Number(values["max-turns"] ?? 20),
          maxCalls: Number(values["max-calls"] ?? 100),
          maxConcurrency: Number(values["max-concurrency"] ?? 1),
        };
        for (const [name, value] of Object.entries(limits)) {
          if (!Number.isSafeInteger(value) || value < (name === "maxCalls" ? 0 : 1))
            return writeUsageError(
              io,
              `${name} must be a ${name === "maxCalls" ? "nonnegative" : "positive"} safe integer.`,
              AGENT_USAGE
            );
        }
        const defaultTools = values.tools?.split(",").map((name) => name.trim());
        if (defaultTools && !defaultTools.every(isDefaultTool))
          return writeUsageError(
            io,
            `--tools accepts a comma-separated subset of ${DEFAULT_TOOLS.join(", ")}.`,
            AGENT_USAGE
          );
        const destinations = { store: values.store, trace: values.trace };
        if (values.trace === "-")
          return writeUsageError(
            io,
            "--trace needs a file path; stdout carries the conversation.",
            AGENT_USAGE
          );
        if (await recordingDestinationsConflict(destinations, io.cwd))
          return writeUsageError(
            io,
            "--store and --trace cannot write to the same path.",
            AGENT_USAGE
          );
        if (values.prompt === undefined && !io.stdin)
          return writeUsageError(
            io,
            "Agent REPL requires stdin; use --prompt for one run.",
            AGENT_USAGE
          );
        if (io.signal?.aborted) return TUBELESS_WORKBENCH_EXIT_CODE.cancellation;
        const environment = await loadAgentEnvironment(values["env-file"], io);
        if ("exitCode" in environment) return environment.exitCode;
        const selected = await loadAgentProvider(
          values["model-module"],
          values.provider,
          environment.env,
          io
        );
        if ("exitCode" in selected) return selected.exitCode;
        // Recording outlives each prompt's cancellation so finished runs stay flushed.
        let recording: WorkbenchRecording;
        try {
          recording = await openWorkbenchRecording(
            destinations,
            io,
            io.signal ?? new AbortController().signal
          );
        } catch (error) {
          io.stderr.write(`Error: ${errorMessage(error)}\n`);
          return toExitCode(error);
        }
        let exitCode: number = TUBELESS_WORKBENCH_EXIT_CODE.execution;
        try {
          exitCode = await runAgentSession(
            {
              model: values.model?.trim() || selected.model,
              env: environment.env,
              prompt: values.prompt,
              instructions: values.instructions,
              limits,
              defaultTools,
              codemode: values.codemode === true,
              graph: !values["no-graph"],
              tracing:
                recording.exporters.length > 0
                  ? { exporter: composeTraceExporters(recording.exporters) }
                  : undefined,
            },
            selected.factory,
            io
          );
        } finally {
          for (const error of await recording.close()) {
            io.stderr.write(`Error: ${errorMessage(error)}\n`);
            if (exitCode === TUBELESS_WORKBENCH_EXIT_CODE.success) exitCode = toExitCode(error);
          }
        }
        return exitCode;
      },
    },
    argv,
    io
  );
}
