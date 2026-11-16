import { createTerminalTextStream } from "./text-stream.js";
import { WORKBENCH_SPECS } from "../workbench-command-specs.js";
import {
  renderWorkbenchUsage,
  parseSubcommandArgs,
  runWorkbenchSubcommand,
} from "../workbench-subcommand.js";
import type { AgentLimits, AgentTranscriptOptions } from "../../agent/agent.js";
import {
  DEFAULT_AGENT_LIMITS,
  minimumAgentLimit,
  validAgentLimit,
} from "../../agent/agent-limits.js";
import {
  DEFAULT_AGENT_TOOL_NAMES,
  isDefaultAgentToolSelection,
} from "../../agent/default-tool-names.js";
import { BUILTIN_AGENT_OPTIONS } from "./options.js";
import { loadAgentEnvironment } from "./environment.js";
import { loadAgentProvider } from "./provider.js";
import { loadDefinedAgent } from "./defined-agent.js";
import { createPromptSession, type AgentPromptSession, type AgentPromptOptions } from "./prompt.js";
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
const BUILTIN_AGENT_OPTION_NAMES = Object.keys(
  BUILTIN_AGENT_OPTIONS
) as (keyof typeof BUILTIN_AGENT_OPTIONS)[];

export function runAgent(argv: readonly string[], io: WorkbenchCliIo): Promise<number> {
  return runWorkbenchSubcommand(
    {
      spec: WORKBENCH_SPECS.agent,
      parse: (args) => parseSubcommandArgs(args, WORKBENCH_SPECS.agent.options),
      async run({ values, positionals }, io) {
        if (positionals.length > 1)
          return writeUsageError(io, "Pass at most one agent ID or file.", AGENT_USAGE);
        const target = positionals[0];
        if (target === undefined && (values.project !== undefined || values.export !== undefined))
          return writeUsageError(
            io,
            "Pass an agent ID or file with --project or --export.",
            AGENT_USAGE
          );
        if (target !== undefined) {
          const provided = BUILTIN_AGENT_OPTION_NAMES.filter((key) => values[key] !== undefined);
          if (provided.length)
            return writeUsageError(
              io,
              `Selected agents own their configuration; remove ${provided.map((key) => `--${key}`).join(", ")} and configure the agent definition instead.`,
              AGENT_USAGE
            );
        }
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
        const limits = {
          maxTurns: Number(values["max-turns"] ?? DEFAULT_AGENT_LIMITS.maxTurns),
          maxCalls: Number(values["max-calls"] ?? DEFAULT_AGENT_LIMITS.maxCalls),
          maxConcurrency: Number(values["max-concurrency"] ?? DEFAULT_AGENT_LIMITS.maxConcurrency),
        } satisfies AgentLimits;
        for (const name of Object.keys(limits) as (keyof typeof limits)[]) {
          if (!validAgentLimit(name, limits[name]))
            return writeUsageError(
              io,
              `${name} must be a ${minimumAgentLimit(name) === 0 ? "nonnegative" : "positive"} safe integer.`,
              AGENT_USAGE
            );
        }
        const defaultTools = values.tools?.split(",").map((name) => name.trim());
        if (defaultTools && !isDefaultAgentToolSelection(defaultTools))
          return writeUsageError(
            io,
            `--tools accepts a comma-separated subset of ${DEFAULT_AGENT_TOOL_NAMES.join(", ")}.`,
            AGENT_USAGE
          );
        if (values["capture-transcript"] && !values.store)
          return writeUsageError(io, "--capture-transcript requires --store.", AGENT_USAGE);
        const destinations = {
          store: values.store,
          trace: values.trace,
          captureTranscript: values["capture-transcript"],
        };
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
        let createChat: (transcript?: AgentTranscriptOptions) => AgentPromptSession;
        let label: string;
        let commandIo = io;
        let projectTracing: AgentPromptOptions["projectTracing"];
        if (target !== undefined) {
          const selected = await loadDefinedAgent(
            target,
            values.export,
            values.project,
            io,
            AGENT_USAGE
          );
          if ("exitCode" in selected) return selected.exitCode;
          createChat = () => selected.chat;
          label = selected.chat.id;
          commandIo = { ...io, cwd: selected.cwd };
          projectTracing = selected.tracing;
        } else {
          const environment = await loadAgentEnvironment(values["env-file"], io);
          if ("exitCode" in environment) return environment.exitCode;
          const selected = await loadAgentProvider(
            values["model-module"],
            values.provider,
            environment.env,
            io
          );
          if ("exitCode" in selected) return selected.exitCode;
          label = values.model?.trim() || selected.model;
          createChat = (transcript) =>
            createPromptSession(
              {
                env: environment.env,
                instructions: values.instructions,
                limits,
                defaultTools,
                codemode: values.codemode === true,
                transcript,
                text: values.stream ? createTerminalTextStream(commandIo) : undefined,
              },
              selected.factory
            );
        }
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
              label,
              projectTracing,
              prompt: values.prompt,
              graph: !values["no-graph"] && !values.stream,
              tracing:
                recording.exporters.length > 0
                  ? { exporter: composeTraceExporters(recording.exporters) }
                  : undefined,
            },
            createChat(recording.transcript),
            commandIo
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
