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
import { optionalToolField, toolObject } from "./default-tool-schema.js";
import { defineTool } from "./tools.js";
import { environmentOperation } from "./environment.js";
import {
  MAX_FILE_BYTES,
  MAX_OUTPUT_BYTES,
  MAX_SEARCH_SNIPPET_BYTES,
} from "./default-tool-limits.js";

const path = wireString({ maxLength: 4096 });
function utf8Text(maxBytes: number, allowEmpty = true) {
  return wireRefine(wireString({ allowEmpty, maxLength: maxBytes }), (value) => {
    if (new TextEncoder().encode(value).length > maxBytes)
      throw new Error(`Text exceeds ${maxBytes} UTF-8 bytes`);
  });
}

function checkOutputBytes(parts: readonly string[]) {
  const encoder = new TextEncoder();
  let bytes = 0;
  for (const part of parts) {
    bytes += encoder.encode(part).length;
    if (bytes > MAX_OUTPUT_BYTES)
      throw new Error(`Tool output content exceeds ${MAX_OUTPUT_BYTES} UTF-8 bytes`);
  }
}

const text = utf8Text(MAX_FILE_BYTES);
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
      content: utf8Text(MAX_OUTPUT_BYTES),
      startLine: count,
      endLine: count,
      totalLines: count,
      truncated: wireBoolean(),
    }),
    run: (input, context) =>
      environmentOperation(context, () => context.environment.read(input, context)),
    dryRun: (input, context) =>
      environmentOperation(context, () => context.environment.read(input, context)),
  }),
  write: defineTool({
    description:
      "Create or replace a UTF-8 file (up to 1 MiB), creating parent directories and following symlinks, including missing targets. Paths resolve from the run cwd. Atomic replacement requires a writable parent directory and permission to preserve existing ownership. Skipped in dry runs.",
    inputSchema: toolObject({ path, content: text }),
    outputSchema: written,
    run: (input, context) =>
      environmentOperation(context, () => context.environment.write(input, context)),
  }),
  edit: defineTool({
    description:
      "Replace one exact occurrence of oldText with newText in a UTF-8 file up to 1 MiB. Missing or ambiguous matches fail without writing. Atomic replacement requires a writable parent directory and permission to preserve existing ownership. Skipped in dry runs.",
    inputSchema: toolObject({
      path,
      oldText: utf8Text(MAX_FILE_BYTES, false),
      newText: text,
    }),
    outputSchema: written,
    run: (input, context) =>
      environmentOperation(context, () => context.environment.edit(input, context)),
  }),
  bash: defineTool({
    description:
      "Run bash in the run cwd or a supplied cwd. Return stdout, stderr, exitCode, signal, timedOut and truncated. timeoutMs defaults to 30000 (maximum 300000); combined output is capped at 16 KiB. Use null for defaults. Skipped in dry runs.",
    inputSchema: toolObject({
      command: wireString({ maxLength: 32_768 }),
      cwd: optionalToolField(path),
      timeoutMs: optionalToolField(positive(300_000)),
    }),
    outputSchema: toolObject(
      {
        cwd: path,
        stdout: utf8Text(MAX_OUTPUT_BYTES),
        stderr: utf8Text(MAX_OUTPUT_BYTES),
        exitCode: wireUnion([count, nullValue]),
        signal: wireUnion([path, nullValue]),
        timedOut: wireBoolean(),
        truncated: wireBoolean(),
      },
      ({ stdout, stderr }) => checkOutputBytes([stdout, stderr])
    ),
    run: (input, context) =>
      environmentOperation(context, () => context.environment.bash(input, context)),
  }),
  list: defineTool({
    description:
      "List up to 200 entries in filename order, defaulting to the run cwd. Retained names are capped at 16 KiB. Return names and file/directory/symlink kinds. Use null for the default path.",
    inputSchema: toolObject({ path: optionalToolField(path) }),
    outputSchema: toolObject({
      path,
      entries: wireRefine(
        wireArray(
          wireObject({
            name: path,
            kind: wireEnum(["file", "directory", "symlink", "other"] as const),
          }),
          { maxItems: 200 }
        ),
        (entries) => checkOutputBytes(entries.map(({ name }) => name))
      ),
      truncated: wireBoolean(),
    }),
    run: (input, context) =>
      environmentOperation(context, () => context.environment.list(input, context)),
    dryRun: (input, context) =>
      environmentOperation(context, () => context.environment.list(input, context)),
  }),
  search: defineTool({
    description:
      "Search for literal, case-sensitive text in a file or directory (default run cwd), traversing entries in filename order. Skip .git, node_modules and nested symlinks. Count binary/oversized files (over 1 MiB) and unavailable descendants in skippedFiles. Examine at most 2000 entries and 32 directory levels; return up to 50 matching lines and 16 KiB. Long-line snippets shift to the match and cap at 1024 bytes. Use null for the default path.",
    inputSchema: toolObject({
      query: wireString({ maxLength: 4096 }),
      path: optionalToolField(path),
    }),
    outputSchema: toolObject({
      matches: wireRefine(
        wireArray(
          wireObject({
            path,
            line: count,
            text: utf8Text(MAX_SEARCH_SNIPPET_BYTES),
          }),
          { maxItems: 50 }
        ),
        (matches) => checkOutputBytes(matches.flatMap(({ path, text }) => [path, text]))
      ),
      truncated: wireBoolean(),
      skippedFiles: count,
    }),
    run: (input, context) =>
      environmentOperation(context, () => context.environment.search(input, context)),
    dryRun: (input, context) =>
      environmentOperation(context, () => context.environment.search(input, context)),
  }),
});

/** The read, write, edit, bash, list and search tools included in every agent. */
export type DefaultAgentTools = typeof defaultTools;
