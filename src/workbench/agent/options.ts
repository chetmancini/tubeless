import { DEFAULT_AGENT_LIMITS } from "../../agent/agent-limits.js";
import { DEFAULT_AGENT_TOOL_NAMES } from "../../agent/default-tool-names.js";
import type { WorkbenchOption } from "../workbench-subcommand.js";

export const BUILTIN_AGENT_OPTIONS = {
  provider: {
    type: "string",
    description: "Named model configuration (default openai); built-in or from --model-module",
    valueName: "name",
    completion: ["openai", "anthropic"],
  },
  model: {
    type: "string",
    description: "Model name (defaults to the selected provider's environment or model)",
    valueName: "name",
    completion: "text",
  },
  "model-module": {
    type: "string",
    description: "Default-export a named provider registry or a single model factory",
    valueName: "file",
    completion: "file",
  },
  "env-file": {
    type: "string",
    description: "Read dotenv values; existing environment values take precedence",
    valueName: "file",
    completion: "file",
  },
  instructions: {
    type: "string",
    description: "Append instructions to the workspace agent prompt",
    valueName: "text",
    completion: "text",
  },
  "max-turns": {
    type: "string",
    description: `Decision limit per prompt (default ${DEFAULT_AGENT_LIMITS.maxTurns})`,
    valueName: "n",
    completion: "text",
  },
  "max-calls": {
    type: "string",
    description: `Tool call limit per prompt (default ${DEFAULT_AGENT_LIMITS.maxCalls})`,
    valueName: "n",
    completion: "text",
  },
  "max-concurrency": {
    type: "string",
    description: `Concurrent decisions/tools (default ${DEFAULT_AGENT_LIMITS.maxConcurrency})`,
    valueName: "n",
    completion: "text",
  },
  tools: {
    type: "string",
    description: `Comma-separated default tools to allow (default ${DEFAULT_AGENT_TOOL_NAMES.join(",")})`,
    valueName: "names",
    completion: "text",
  },
  codemode: {
    type: "boolean",
    description: "Offer one JavaScript codemode tool that calls the workspace tools",
  },
  stream: {
    type: "boolean",
    description: "Stream public assistant text to stderr (uses plain progress output).",
  },
  "capture-transcript": {
    type: "boolean",
    description: "Save built-in agent prompts, answers and tool content in --store (opt-in)",
  },
} as const satisfies Readonly<Record<string, WorkbenchOption>>;
