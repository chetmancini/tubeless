import {
  wireArray,
  wireBoolean,
  wireCustom,
  wireEnum,
  wireNumber,
  wireObject,
  wireRefine,
  wireString,
  wireUnion,
} from "../tracing/wire-schema.js";
import { bashTool } from "./default-tool-bash.js";
import {
  editTool,
  listTool,
  MAX_FILE_BYTES,
  readTool,
  searchTool,
  writeTool,
} from "./default-tool-files.js";
import { optionalToolField, toolObject } from "./default-tool-schema.js";
import { defineTool } from "./tools.js";

const path = wireString({ maxLength: 4096 });
const text = wireString({ allowEmpty: true, maxLength: MAX_FILE_BYTES });
const count = wireNumber({ integer: true, minimum: 0 });
function positive(maximum: number) {
  const number = wireNumber({ integer: true, minimum: 1 });
  return wireRefine(
    number,
    (value) => {
      if (value > maximum) throw new Error(`Expected a value at most ${maximum}`);
    },
    { ...number.jsonSchema, maximum }
  );
}
const nullValue = wireCustom<null>({ type: "null" }, (value) => {
  if (value !== null) throw new Error("Expected null");
  return null;
});
const written = toolObject({ path, bytes: count });

export const defaultTools = Object.freeze({
  read: defineTool({
    description:
      "Read a UTF-8 file up to 1 MiB. Paths resolve from the run cwd. startLine is 1-based (default 1); maxLines defaults to 200. Output is capped at 16 KiB. Use null for defaults.",
    inputSchema: toolObject({
      path,
      startLine: optionalToolField(positive(Number.MAX_SAFE_INTEGER)),
      maxLines: optionalToolField(positive(2000)),
    }),
    outputSchema: toolObject({
      path,
      content: text,
      startLine: count,
      endLine: count,
      totalLines: count,
      truncated: wireBoolean(),
    }),
    run: readTool,
    dryRun: readTool,
  }),
  write: defineTool({
    description:
      "Create or replace a UTF-8 file (up to 1 MiB), creating parent directories and following symlinks, including missing targets. Paths resolve from the run cwd. Atomic replacement requires a writable parent directory and permission to preserve existing ownership. Skipped in dry runs.",
    inputSchema: toolObject({ path, content: text }),
    outputSchema: written,
    run: writeTool,
  }),
  edit: defineTool({
    description:
      "Replace one exact occurrence of oldText with newText in a UTF-8 file up to 1 MiB. Missing or ambiguous matches fail without writing. Atomic replacement requires a writable parent directory and permission to preserve existing ownership. Skipped in dry runs.",
    inputSchema: toolObject({
      path,
      oldText: wireString({ maxLength: MAX_FILE_BYTES }),
      newText: text,
    }),
    outputSchema: written,
    run: editTool,
  }),
  bash: defineTool({
    description:
      "Run bash in the run cwd or a supplied cwd. Return stdout, stderr, exitCode, signal, timedOut and truncated. timeoutMs defaults to 30000 (maximum 300000); combined output is capped at 16 KiB. Use null for defaults. Skipped in dry runs.",
    inputSchema: toolObject({
      command: wireString({ maxLength: 32_768 }),
      cwd: optionalToolField(path),
      timeoutMs: optionalToolField(positive(300_000)),
    }),
    outputSchema: toolObject({
      cwd: path,
      stdout: text,
      stderr: text,
      exitCode: wireUnion([count, nullValue]),
      signal: wireUnion([path, nullValue]),
      timedOut: wireBoolean(),
      truncated: wireBoolean(),
    }),
    run: bashTool,
  }),
  list: defineTool({
    description:
      "List up to 200 entries in filename order, defaulting to the run cwd. Return names and file/directory/symlink kinds. Use null for the default path.",
    inputSchema: toolObject({ path: optionalToolField(path) }),
    outputSchema: toolObject({
      path,
      entries: wireArray(
        wireObject({
          name: path,
          kind: wireEnum(["file", "directory", "symlink", "other"] as const),
        }),
        { maxItems: 200 }
      ),
      truncated: wireBoolean(),
    }),
    run: listTool,
    dryRun: listTool,
  }),
  search: defineTool({
    description:
      "Search for literal, case-sensitive text in a file or directory (default run cwd), traversing entries in filename order. Skip .git, node_modules and nested symlinks. Count binary/oversized files (over 1 MiB) and unavailable descendants in skippedFiles. Examine at most 2000 entries and 32 directory levels; return up to 50 matching lines and 16 KiB. Long-line snippets shift to the match and cap at 1024 bytes. Use null for the default path.",
    inputSchema: toolObject({
      query: wireString({ maxLength: 4096 }),
      path: optionalToolField(path),
    }),
    outputSchema: toolObject({
      matches: wireArray(wireObject({ path, line: count, text }), { maxItems: 50 }),
      truncated: wireBoolean(),
      skippedFiles: count,
    }),
    run: searchTool,
    dryRun: searchTool,
  }),
});

/** The read, write, edit, bash, list and search tools included in every agent. */
export type DefaultAgentTools = typeof defaultTools;
