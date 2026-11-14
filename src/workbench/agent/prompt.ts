import {
  createAgentSession,
  defineAgent,
  type AgentLimits,
  type AgentModel,
  type AgentSession,
  type DefaultAgentToolName,
} from "../../agent/agent.js";
import type { PipelineLogger } from "../../core/pipeline.js";
import type { PipelineTracingOptions } from "../../tracing/tracing-contracts.js";
import type { AgentModelFactory } from "../../cli/cli-agent-provider.js";
import type { ProjectOptions } from "../../project/pipeline-project.js";
import { createLaunchTracing } from "../../hosting/launch-tracing.js";
import { createPipelineReporter } from "../../reporter/interactive-reporter.js";
import { safeTerminalLog, safeTerminalText } from "../../reporter/terminal-text.js";
import { awaitWithAbort, throwIfAborted } from "../../utilities/abort.js";
import {
  commandContext,
  errorMessage,
  TUBELESS_WORKBENCH_EXIT_CODE,
  type WorkbenchCliIo,
} from "../workbench-shared.js";

export interface AgentPromptOptions {
  readonly label: string;
  readonly graph: boolean;
  /** Records every prompt's run; the caller owns the destinations' lifetime. */
  readonly tracing?: PipelineTracingOptions;
  readonly projectTracing?: ProjectOptions["tracing"];
}

interface BuiltinAgentOptions {
  readonly env: Readonly<NodeJS.ProcessEnv>;
  readonly instructions?: string;
  readonly limits: AgentLimits;
  readonly defaultTools?: readonly DefaultAgentToolName[];
  readonly codemode?: boolean;
}

type PromptOutcome =
  | { readonly status: "completed"; readonly answer: string }
  | { readonly status: "failed" | "cancelled"; readonly message: string };

/** One CLI conversation; only built-in sessions initialize a model for each prompt. */
export interface AgentPromptSession {
  readonly id: string;
  readonly session: AgentSession<{ task: string }, { answer: string }>;
  /** Absent when an application-defined agent owns its fixed model. */
  prepare?(model: string, signal: AbortSignal): Promise<void>;
}

export function createPromptSession(
  options: BuiltinAgentOptions,
  factory: AgentModelFactory
): AgentPromptSession {
  let provider: AgentModel | undefined;
  const agent = defineAgent({
    id: "tubeless-agent",
    model: (request, context) => {
      if (!provider) throw new Error("No model is selected for this prompt.");
      return provider(request, context);
    },
    instructions: options.instructions,
    limits: options.limits,
    defaultTools: options.defaultTools,
    codemode: options.codemode,
  });
  return {
    id: agent.id,
    session: createAgentSession(agent),
    async prepare(model, signal) {
      throwIfAborted(signal, "Model initialization");
      const initialized: unknown = await awaitWithAbort(
        Promise.resolve(factory({ model, signal, env: options.env })),
        signal,
        "Model initialization"
      );
      if (typeof initialized !== "function")
        throw new Error("Model factory must return an AgentModel function.");
      // SAFETY: trusted plugin; the agent validates every returned decision.
      provider = initialized as AgentModel;
    },
  };
}

function promptLogger(io: WorkbenchCliIo): PipelineLogger {
  const write = (output: WorkbenchCliIo["stdout"], values: unknown[]) =>
    output.write(`${safeTerminalLog(values.map(String).join(" "))}\n`);
  return {
    log: (...values) => {
      write(io.stdout, values);
    },
    warn: (...values) => {
      write(io.stderr, values);
    },
    error: (...values) => {
      write(io.stderr, values);
    },
  };
}

/** Run an ordinary pipeline reporter, disposing it before the answer or next prompt. */
export async function executeAgentPrompt(
  task: string,
  options: AgentPromptOptions,
  io: WorkbenchCliIo,
  signal: AbortSignal,
  chat: AgentPromptSession
): Promise<number> {
  io.stdout.write(`\nagent · ${safeTerminalText(options.label)}\n`);
  const context = commandContext(io, signal);
  const reporter = options.graph
    ? createPipelineReporter<{ answer: string }>({
        log: context.log,
        output: context.reporterOutput,
      })
    : undefined;
  let outcome: PromptOutcome;
  const tracing = createLaunchTracing({
    context: { pipelineId: chat.id, cwd: io.cwd, signal },
    configurations: [options.projectTracing],
    exporters: options.tracing ? [options.tracing.exporter] : [],
  });
  try {
    throwIfAborted(signal, "Model initialization");
    await chat.prepare?.(options.label, signal);
    // The session commits the conversation only after this run completes and finalizes.
    const run = await chat.session.run({ task }, undefined, {
      cwd: io.cwd,
      signal,
      // Interactive reporting sanitizes and scopes logs itself. Plain model/tool
      // logs are sanitized separately from the reporter's trusted styling.
      log: reporter?.mode === "interactive" ? reporter.log : promptLogger(io),
      hooks: reporter?.hooks,
      tracing: tracing.prepare(),
    });
    if (run.status === "completed" && run.finalized) {
      outcome = { status: "completed", answer: run.value.answer };
    } else {
      const failedStatus = run.status === "cancelled" ? "cancelled" : "failed";
      outcome = {
        status: failedStatus,
        message: `${failedStatus === "cancelled" ? "Cancelled" : "Agent failed"}: ${run.errors.map((error) => safeTerminalText(error.message)).join("; ")}`,
      };
    }
  } catch (error) {
    const status = signal.aborted ? "cancelled" : "failed";
    outcome = {
      status,
      message: `${status === "cancelled" ? "Cancelled" : "Error"}: ${safeTerminalText(errorMessage(error))}`,
    };
  } finally {
    await tracing.close();
    reporter?.dispose();
  }
  if (outcome.status === "completed") {
    io.stdout.write(`\n${safeTerminalLog(outcome.answer)}\n\n`);
    return TUBELESS_WORKBENCH_EXIT_CODE.success;
  }
  io.stderr.write(`${outcome.message}\n`);
  return outcome.status === "cancelled"
    ? TUBELESS_WORKBENCH_EXIT_CODE.cancellation
    : TUBELESS_WORKBENCH_EXIT_CODE.execution;
}
