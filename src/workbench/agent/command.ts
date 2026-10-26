import { WORKBENCH_SPECS } from "../workbench-command-specs.js";
import {
  renderWorkbenchUsage,
  parseSubcommandArgs,
  runWorkbenchSubcommand,
} from "../workbench-subcommand.js";
import { pathToFileURL } from "node:url";
import type { AgentLimits, DefaultAgentToolName } from "../../agent/agent.js";
import { openaiModel } from "../../agent/openai.js";
import { loadAgentEnvironment } from "./environment.js";
import type { AgentModelFactory } from "./prompt.js";
import { runAgentSession } from "./session.js";
import {
  loadWorkbenchModule,
  TUBELESS_WORKBENCH_EXIT_CODE,
  writeUsageError,
  type WorkbenchCliIo,
} from "../workbench-shared.js";

const AGENT_USAGE = renderWorkbenchUsage(WORKBENCH_SPECS.agent);
async function loadModelFactory(
  file: string | undefined,
  env: Readonly<NodeJS.ProcessEnv>,
  io: WorkbenchCliIo
): Promise<AgentModelFactory | { exitCode: number }> {
  if (!file) {
    const apiKey = env.OPENAI_API_KEY?.trim();
    if (!apiKey) {
      io.stderr.write(
        "Error: OPENAI_API_KEY is missing from the agent environment.\n" +
          "If echo $OPENAI_API_KEY works, run export OPENAI_API_KEY in that shell, then retry.\n" +
          "Alternatively, use tubeless agent --env-file /path/to/.env.\n"
      );
      return { exitCode: TUBELESS_WORKBENCH_EXIT_CODE.usage };
    }
    if (!/^[\x21-\x7e]+$/.test(apiKey)) {
      io.stderr.write(
        "Error: OPENAI_API_KEY must be a single token without whitespace or control characters.\n"
      );
      return { exitCode: TUBELESS_WORKBENCH_EXIT_CODE.usage };
    }
    return ({ model }) => openaiModel({ model, apiKey });
  }
  return loadWorkbenchModule(file, io, async (filePath) => {
    const module: unknown = await import(pathToFileURL(filePath).href);
    if (
      typeof module !== "object" ||
      module === null ||
      !("default" in module) ||
      typeof module.default !== "function"
    )
      throw new Error(
        "Model module must default-export a factory ({ model, signal, env }) => AgentModel."
      );
    // SAFETY: this is a trusted plugin; the task boundary validates the factory's return value.
    return module.default as AgentModelFactory;
  });
}

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
        if (values.prompt === undefined && !io.stdin)
          return writeUsageError(
            io,
            "Agent REPL requires stdin; use --prompt for one run.",
            AGENT_USAGE
          );
        if (io.signal?.aborted) return TUBELESS_WORKBENCH_EXIT_CODE.cancellation;
        const environment = await loadAgentEnvironment(values["env-file"], io);
        if ("exitCode" in environment) return environment.exitCode;
        const factory = await loadModelFactory(values["model-module"], environment.env, io);
        if (typeof factory !== "function") return factory.exitCode;
        return runAgentSession(
          {
            model: (values.model ?? environment.env.OPENAI_MODEL)?.trim() || "gpt-5.4-mini",
            env: environment.env,
            prompt: values.prompt,
            instructions: values.instructions,
            limits,
            defaultTools,
            codemode: values.codemode === true,
            graph: !values["no-graph"],
          },
          factory,
          io
        );
      },
    },
    argv,
    io
  );
}
