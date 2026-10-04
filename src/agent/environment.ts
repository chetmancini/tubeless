import type { PipelineStepContext } from "../core/pipeline-types.js";
import type { Awaitable } from "./agent-types.js";

/** Workspace and cancellation shared by an agent's environment operations. */
export type AgentEnvironmentContext = Pick<PipelineStepContext<object>, "cwd" | "signal">;

/** One scoped guidance file, loaded by the workspace that owns it. */
export interface AgentProjectInstruction {
  readonly path: string;
  readonly content: string;
}

/** Filesystem and command capabilities supplied by a local or remote workspace. */
export interface AgentEnvironment {
  /** Stable namespace identity; equal IDs refer to the same workspace authority. */
  readonly id: string;
  resolveCwd(context: AgentEnvironmentContext): Awaitable<string>;
  projectInstructions(
    context: AgentEnvironmentContext
  ): Awaitable<readonly AgentProjectInstruction[]>;
  /** Return at most 16 KiB of UTF-8 content. */
  read(
    input: { path: string; startLine?: number | null; maxLines?: number | null },
    context: AgentEnvironmentContext
  ): Awaitable<{
    path: string;
    content: string;
    startLine: number;
    endLine: number;
    totalLines: number;
    truncated: boolean;
  }>;
  /** Accept at most 1 MiB of UTF-8 content and enforce the same file-size limit. */
  write(
    input: { path: string; content: string },
    context: AgentEnvironmentContext
  ): Awaitable<{ path: string; bytes: number }>;
  /** Accept old/new text of at most 1 MiB each and enforce the completed file-size limit. */
  edit(
    input: { path: string; oldText: string; newText: string },
    context: AgentEnvironmentContext
  ): Awaitable<{ path: string; bytes: number }>;
  /** Return at most 16 KiB of combined UTF-8 stdout/stderr. */
  bash(
    input: { command: string; cwd?: string | null; timeoutMs?: number | null },
    context: AgentEnvironmentContext
  ): Awaitable<{
    cwd: string;
    stdout: string;
    stderr: string;
    exitCode: number | null;
    signal: string | null;
    timedOut: boolean;
    truncated: boolean;
  }>;
  /** Return up to 200 entries with at most 16 KiB of UTF-8 names. */
  list(
    input: { path?: string | null },
    context: AgentEnvironmentContext
  ): Awaitable<{
    path: string;
    entries: { name: string; kind: "file" | "directory" | "symlink" | "other" }[];
    truncated: boolean;
  }>;
  /** Return up to 50 matches, 1024 UTF-8 bytes per snippet and 16 KiB of path/text content. */
  search(
    input: { query: string; path?: string | null },
    context: AgentEnvironmentContext
  ): Awaitable<{
    matches: { path: string; line: number; text: string }[];
    truncated: boolean;
    skippedFiles: number;
  }>;
}

/** A workspace capability or a factory resolved once per live agent invocation. */
export type AgentEnvironmentProvider =
  | AgentEnvironment
  | ((context: AgentEnvironmentContext) => Awaitable<AgentEnvironment>);

export function checkEnvironment(environment: AgentEnvironment): AgentEnvironment {
  if (
    !environment ||
    typeof environment.id !== "string" ||
    !environment.id.trim() ||
    environment.id.length > 4096
  )
    throw new Error("Agent environment requires a stable nonblank id of at most 4096 characters");
  for (const name of [
    "resolveCwd",
    "projectInstructions",
    "read",
    "write",
    "edit",
    "bash",
    "list",
    "search",
  ] as const)
    if (typeof environment[name] !== "function")
      throw new Error(`Agent environment requires ${name}`);
  return environment;
}
