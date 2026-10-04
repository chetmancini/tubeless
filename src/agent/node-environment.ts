import { lstat, realpath } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { throwIfAborted } from "../utilities/abort.js";
import { bashTool } from "./default-tool-bash.js";
import { readTool, writeTool, editTool, listTool, searchTool } from "./default-tool-files.js";
import type {
  AgentEnvironment,
  AgentEnvironmentContext,
  AgentProjectInstruction,
} from "./environment.js";

function missing(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function projectInstructions(
  context: AgentEnvironmentContext
): Promise<readonly AgentProjectInstruction[]> {
  const { cwd, signal } = context;
  const workspace = await realpath(cwd);
  const ancestors: string[] = [];
  let directory = workspace;
  while (true) {
    throwIfAborted(signal, "Load project instructions");
    ancestors.push(directory);
    const git = await lstat(join(directory, ".git")).catch((error: unknown) => {
      if (!missing(error)) throw error;
      return undefined;
    });
    if (git) break;
    const parent = dirname(directory);
    if (parent === directory) {
      ancestors.splice(1);
      break;
    }
    directory = parent;
  }
  const instructions: AgentProjectInstruction[] = [];
  for (const path of ancestors.reverse().map((ancestor) => join(ancestor, "AGENTS.md"))) {
    try {
      const file = await readTool({ path, maxLines: 2000 }, { cwd: workspace, signal });
      if (file.truncated) throw new Error(`Project instructions exceed read limits: ${path}`);
      instructions.push({ path, content: file.content });
    } catch (error) {
      if (!missing(error)) throw error;
    }
  }
  return instructions;
}

/** Local workspace capabilities with bounded reads, atomic writes and cancellable bash. */
export function createNodeAgentEnvironment(): AgentEnvironment {
  return Object.freeze({
    id: `node:${hostname()}`,
    resolveCwd: async ({ cwd, signal }: AgentEnvironmentContext) => {
      throwIfAborted(signal, "Resolve agent workspace");
      const directory = await realpath(cwd);
      throwIfAborted(signal, "Resolve agent workspace");
      return directory;
    },
    projectInstructions,
    read: readTool,
    write: writeTool,
    edit: editTool,
    bash: bashTool,
    list: listTool,
    search: searchTool,
  });
}
