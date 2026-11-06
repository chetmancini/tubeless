import { lstat, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { throwIfAborted } from "../utilities/abort.js";
import { runConcurrent } from "../utilities/batch.js";
import { MAX_READ_LINES } from "./default-tool-limits.js";
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
  const instructions = await runConcurrent(
    ancestors.reverse().map((ancestor) => join(ancestor, "AGENTS.md")),
    { concurrency: 4, signal },
    async (path): Promise<AgentProjectInstruction | undefined> => {
      try {
        const file = await readTool({ path, maxLines: MAX_READ_LINES }, { cwd: workspace, signal });
        if (file.truncated) throw new Error(`Project instructions exceed read limits: ${path}`);
        return { path, content: file.content };
      } catch (error) {
        if (!missing(error)) throw error;
        return undefined;
      }
    }
  );
  return instructions.filter((instruction) => instruction !== undefined);
}

/**
 * Local workspace capabilities with bounded reads, atomic writes and cancellable bash.
 *
 * The default `id` names this process's local filesystem authority rather than its
 * host, so durable checkpoints still resume in a recreated container or pod. Pass
 * `id` to name a distinct authority, for example one store shared by several hosts.
 */
export function createNodeAgentEnvironment(
  options: { readonly id?: string } = {}
): AgentEnvironment {
  return Object.freeze({
    id: options.id ?? "node:local",
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
