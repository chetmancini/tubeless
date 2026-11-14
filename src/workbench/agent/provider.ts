import { pathToFileURL } from "node:url";
import type { AgentModelFactory, AgentProvider } from "../../cli/cli-agent-provider.js";
import { WORKBENCH_SPECS } from "../workbench-command-specs.js";
import { renderWorkbenchUsage } from "../workbench-subcommand.js";
import {
  loadWorkbenchModule,
  terminalSafeText,
  TUBELESS_WORKBENCH_EXIT_CODE,
  writeUsageError,
  type WorkbenchCliIo,
} from "../workbench-shared.js";
import { BUILTIN_AGENT_PROVIDERS } from "./builtin-providers.js";

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const envName = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);

function provider(value: unknown): value is AgentProvider {
  return (
    record(value) &&
    typeof value.model === "string" &&
    !!value.model.trim() &&
    typeof value.createModel === "function" &&
    (value.modelEnv === undefined || envName(value.modelEnv)) &&
    (value.credentialEnv === undefined ||
      (Array.isArray(value.credentialEnv) && value.credentialEnv.every(envName)))
  );
}

/** Resolve named configurations without assigning protocols or endpoints to provider names. */
export async function loadAgentProvider(
  file: string | undefined,
  name: string | undefined,
  env: Readonly<NodeJS.ProcessEnv>,
  io: WorkbenchCliIo
): Promise<{ factory: AgentModelFactory; model: string } | { exitCode: number }> {
  const invalid = (message: string) => ({
    exitCode: writeUsageError(io, message, renderWorkbenchUsage(WORKBENCH_SPECS.agent)),
  });
  let registry: Readonly<Record<string, unknown>> = BUILTIN_AGENT_PROVIDERS;
  if (file !== undefined) {
    const loaded = await loadWorkbenchModule(file, io, async (filePath) => {
      const module: unknown = await import(pathToFileURL(filePath).href);
      if (!record(module) || (typeof module.default !== "function" && !record(module.default)))
        throw new Error(
          "Model module must default-export a factory ({ model, signal, env }) => AgentModel or a provider registry."
        );
      return { value: module.default };
    });
    if ("exitCode" in loaded) return loaded;
    if (typeof loaded.value === "function") {
      if (name !== undefined)
        return invalid("--provider requires a provider registry when used with --model-module.");
      // SAFETY: trusted plugin; executeAgentPrompt validates the factory's return value.
      return {
        factory: loaded.value as AgentModelFactory,
        model: env.OPENAI_MODEL?.trim() || BUILTIN_AGENT_PROVIDERS.openai.model,
      };
    }
    registry = loaded.value;
  }
  const selected = name ?? "openai";
  if (!Object.hasOwn(registry, selected))
    return invalid(
      `Unknown agent provider: ${terminalSafeText(selected)}. Select a configured provider with --provider.`
    );
  const config = registry[selected];
  if (!provider(config))
    return invalid(
      "Agent provider must declare a nonblank model and createModel factory, with optional modelEnv and credentialEnv variable names."
    );
  const readEnv = (key: string) => (Object.hasOwn(env, key) ? env[key]?.trim() : undefined);
  const credentials = config.credentialEnv ?? [];
  const credentialName = credentials.find((key) => readEnv(key)) ?? credentials[0];
  if (credentialName !== undefined) {
    const credential = readEnv(credentialName);
    if (!credential) {
      io.stderr.write(
        `Error: ${credentialName} is missing from the agent environment.\n` +
          `If echo $${credentialName} works, run export ${credentialName} in that shell, then retry.\n` +
          "Alternatively, use tubeless agent --env-file /path/to/.env.\n"
      );
      return { exitCode: TUBELESS_WORKBENCH_EXIT_CODE.usage };
    }
    if (!/^[\x21-\x7e]+$/.test(credential)) {
      io.stderr.write(
        `Error: ${credentialName} must be a single token without whitespace or control characters.\n`
      );
      return { exitCode: TUBELESS_WORKBENCH_EXIT_CODE.usage };
    }
  }
  return {
    factory: config.createModel,
    model: (config.modelEnv && readEnv(config.modelEnv)) || config.model.trim(),
  };
}
