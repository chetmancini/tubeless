import { exactFields } from "./data.js";
import {
  isNodeCheckFilePath,
  NODE_CHECK_FILE_LIMITS,
  normalizeNodeCheckFiles,
  type NodeCheckFileCompletion,
} from "./files.js";

export type FileExecution = { complete: boolean; files: NodeCheckFileCompletion[] };

export function decodeFileExecution(value: unknown): FileExecution | null {
  if (value === null) return null;
  const { complete, files } = exactFields(value, ["complete", "files"], "Vitest file execution");
  if (
    typeof complete !== "boolean" ||
    !Array.isArray(files) ||
    files.length > NODE_CHECK_FILE_LIMITS.files
  )
    throw new TypeError("Invalid Vitest file execution evidence.");
  const completed = Array.from(files, (file: unknown): NodeCheckFileCompletion => {
    const { path, state, durationMs } = exactFields(
      file,
      ["path", "state", "durationMs"],
      "Vitest file completion"
    );
    if (
      !isNodeCheckFilePath(path) ||
      (state !== "passed" && state !== "failed" && state !== "skipped") ||
      (durationMs !== null &&
        (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs < 0))
    )
      throw new TypeError("Invalid Vitest file completion.");
    return { path, state, durationMs };
  });
  normalizeNodeCheckFiles(completed.map(({ path }) => path));
  completed.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { complete, files: completed };
}

export function matchesCompletedFiles(
  execution: FileExecution,
  expected: readonly string[]
): boolean {
  return (
    execution.complete &&
    expected.length > 0 &&
    expected.length === execution.files.length &&
    execution.files.every(({ path }, index) => path === expected[index])
  );
}

export function acceptedFileExecution(execution: FileExecution): boolean {
  return (
    execution.complete &&
    execution.files.some(({ state }) => state === "passed") &&
    !execution.files.some(({ state }) => state === "failed")
  );
}
