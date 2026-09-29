import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { PipelineStepContext } from "../core/pipeline-types.js";
import { throwIfAborted } from "../utilities/abort.js";
import { ToolError } from "./tools.js";

type Context = Pick<PipelineStepContext<object>, "cwd" | "signal">;
export const MAX_FILE_BYTES = 1_048_576;
export const MAX_OUTPUT_BYTES = 16_384;

function clippedText(text: string, maxBytes = MAX_OUTPUT_BYTES) {
  const bytes = Buffer.from(text);
  return {
    text: new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes.subarray(0, maxBytes), {
      stream: bytes.length > maxBytes,
    }),
    truncated: bytes.length > maxBytes,
  };
}

async function sortedEntries(path: string, signal?: AbortSignal) {
  throwIfAborted(signal, "List files");
  const entries = await readdir(path, { withFileTypes: true });
  throwIfAborted(signal, "List files");
  return entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function unavailableEntry(error: unknown) {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    ["EACCES", "EPERM", "ENOENT", "ENOTDIR"].includes(error.code)
  );
}

async function fileOperation<T>(context: Context, work: () => Promise<T>): Promise<T> {
  throwIfAborted(context.signal, "Agent tool");
  try {
    const result = await work();
    throwIfAborted(context.signal, "Agent tool");
    return result;
  } catch (error) {
    throwIfAborted(context.signal, "Agent tool");
    if (error instanceof Error && "code" in error && typeof error.code === "string")
      throw new ToolError(error.code, clippedText(error.message, 4096).text);
    throw error;
  }
}

async function readText(path: string, signal?: AbortSignal): Promise<string> {
  throwIfAborted(signal, "Read file");
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new ToolError("NOT_FILE", "Expected a regular file");
    if (info.size > MAX_FILE_BYTES) throw new ToolError("FILE_TOO_LARGE", "File exceeds 1 MiB");
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      throwIfAborted(signal, "Read file");
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > MAX_FILE_BYTES) throw new ToolError("FILE_TOO_LARGE", "File exceeds 1 MiB");
    const bytes = buffer.subarray(0, length);
    if (bytes.includes(0)) throw new ToolError("NOT_TEXT", "Expected a UTF-8 text file");
    try {
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      throw new ToolError("NOT_TEXT", "Expected a UTF-8 text file");
    }
  } finally {
    await file.close();
  }
}

export async function readTool(
  input: { path: string; startLine?: number | null; maxLines?: number | null },
  context: Context
) {
  return fileOperation(context, async () => {
    const path = resolve(context.cwd, input.path);
    const text = await readText(path, context.signal);
    const lines = text.length === 0 ? [] : text.split(/\r?\n/);
    const startLine = input.startLine ?? 1;
    const selected = lines.slice(startLine - 1, startLine - 1 + (input.maxLines ?? 200));
    const content = clippedText(selected.join("\n"));
    const endLine =
      selected.length === 0 ? startLine - 1 : startLine + content.text.split("\n").length - 1;
    return {
      path,
      content: content.text,
      startLine,
      endLine,
      totalLines: lines.length,
      truncated: content.truncated || endLine < lines.length,
    };
  });
}

export async function writeTool(input: { path: string; content: string }, context: Context) {
  return fileOperation(context, async () => {
    const path = resolve(context.cwd, input.path);
    const bytes = Buffer.byteLength(input.content);
    if (bytes > MAX_FILE_BYTES) throw new ToolError("FILE_TOO_LARGE", "Content exceeds 1 MiB");
    await mkdir(dirname(path), { recursive: true });
    throwIfAborted(context.signal, "Write file");
    const entry = await lstat(path).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
      throw error;
    });
    // Preserve an existing symlink and replace its resolved target, not the link.
    const destination = entry?.isSymbolicLink() ? await realpath(path) : path;
    const info = entry?.isSymbolicLink() ? await stat(destination) : entry;
    if (info && !info.isFile()) throw new ToolError("NOT_FILE", "Expected a regular file");
    if (info) await access(destination, constants.W_OK);
    const staging = await mkdtemp(join(dirname(destination), ".tubeless-write-"));
    try {
      const temporary = join(staging, "content");
      const file = await open(temporary, "wx", info ? info.mode & 0o777 : 0o666);
      try {
        await file.writeFile(input.content, { encoding: "utf8", signal: context.signal });
        // Creation applies umask; restore existing permission bits after writing.
        if (info) await file.chmod(info.mode & 0o777);
      } finally {
        await file.close();
      }
      throwIfAborted(context.signal, "Write file");
      await rename(temporary, destination);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
    return { path, bytes };
  });
}

export async function editTool(
  input: { path: string; oldText: string; newText: string },
  context: Context
) {
  return fileOperation(context, async () => {
    const path = resolve(context.cwd, input.path);
    const text = await readText(path, context.signal);
    const index = text.indexOf(input.oldText);
    if (index < 0) throw new ToolError("EDIT_NOT_FOUND", "oldText does not occur in the file");
    if (text.indexOf(input.oldText, index + 1) >= 0)
      throw new ToolError("EDIT_AMBIGUOUS", "oldText occurs more than once; include more context");
    return writeTool(
      {
        path,
        content: text.slice(0, index) + input.newText + text.slice(index + input.oldText.length),
      },
      context
    );
  });
}

export async function listTool(input: { path?: string | null }, context: Context) {
  return fileOperation(context, async () => {
    const path = resolve(context.cwd, input.path ?? ".");
    const entries: { name: string; kind: "file" | "directory" | "symlink" | "other" }[] = [];
    let truncated = false;
    let bytes = 0;
    for (const entry of await sortedEntries(path, context.signal)) {
      throwIfAborted(context.signal, "List files");
      bytes += Buffer.byteLength(entry.name);
      if (entries.length === 200 || bytes > MAX_OUTPUT_BYTES) {
        truncated = true;
        break;
      }
      entries.push({
        name: entry.name,
        kind: entry.isSymbolicLink()
          ? "symlink"
          : entry.isDirectory()
            ? "directory"
            : entry.isFile()
              ? "file"
              : "other",
      });
    }
    return { path, entries, truncated };
  });
}

export async function searchTool(input: { query: string; path?: string | null }, context: Context) {
  return fileOperation(context, async () => {
    const root = resolve(context.cwd, input.path ?? ".");
    const matches: { path: string; line: number; text: string }[] = [];
    let entries = 0;
    let bytes = 0;
    let truncated = false;
    let skippedFiles = 0;
    async function searchFile(path: string, discovered = false) {
      let text: string;
      try {
        text = await readText(path, context.signal);
      } catch (error) {
        throwIfAborted(context.signal, "Search files");
        if (
          (error instanceof ToolError &&
            ["FILE_TOO_LARGE", "NOT_TEXT", "NOT_FILE"].includes(error.code)) ||
          (discovered && unavailableEntry(error))
        ) {
          skippedFiles++;
          return;
        }
        throw error;
      }
      const lines = text.split(/\r?\n/);
      for (let index = 0; index < lines.length; index++) {
        const source = lines[index]!;
        const match = source.indexOf(input.query);
        if (match < 0) continue;
        const line = clippedText(source, 1024);
        if (line.truncated && !line.text.includes(input.query))
          line.text = clippedText(source.slice(match), 1024).text;
        bytes += Buffer.byteLength(path) + Buffer.byteLength(line.text);
        if (matches.length === 50 || bytes > MAX_OUTPUT_BYTES) {
          truncated = true;
          return;
        }
        matches.push({ path, line: index + 1, text: line.text });
        if (line.truncated) truncated = true;
      }
    }
    async function walk(path: string, depth: number): Promise<void> {
      if (depth > 32) {
        truncated = true;
        return;
      }
      const children = await sortedEntries(path, context.signal).catch((error: unknown) => {
        throwIfAborted(context.signal, "Search files");
        if (depth === 0 || !unavailableEntry(error)) throw error;
        skippedFiles++;
        return [];
      });
      for (const entry of children) {
        throwIfAborted(context.signal, "Search files");
        if (++entries > 2000 || matches.length >= 50 || bytes > MAX_OUTPUT_BYTES) {
          truncated = true;
          return;
        }
        if (entry.isDirectory() && entry.name !== ".git" && entry.name !== "node_modules")
          await walk(join(path, entry.name), depth + 1);
        else if (entry.isFile()) await searchFile(join(path, entry.name), true);
      }
    }
    if ((await stat(root)).isFile()) await searchFile(root);
    else await walk(root, 0);
    return { matches, truncated, skippedFiles };
  });
}
