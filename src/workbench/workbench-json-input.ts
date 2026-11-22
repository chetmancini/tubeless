import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import { awaitWithAbort } from "../utilities/abort.js";
import { BodyLimitError, readBoundedBody } from "../utilities/read-body.js";

const CLI_INPUT_MAX_BYTES = 64 * 1024;

export class CliInputError extends Error {}

export interface CliInputContext {
  cwd: string;
  signal: AbortSignal;
  readStdin?: () => Promise<string>;
}

/** Read bounded input from a regular file or stdin without opening an unbounded stream. */
export async function readCliJson(
  file: string,
  context: CliInputContext,
  label: string
): Promise<unknown> {
  let text: string;
  if (file === "-") {
    if (context.readStdin)
      text = await awaitWithAbort(context.readStdin(), context.signal, "Input read");
    else {
      // SAFETY: the CLI's unencoded stdin supplies byte chunks.
      const stdin = Readable.toWeb(process.stdin, {
        strategy: { highWaterMark: 0 },
      }) as ReadableStream<Uint8Array>;
      try {
        text = Buffer.from(
          await readBoundedBody(stdin, CLI_INPUT_MAX_BYTES, context.signal)
        ).toString("utf8");
      } catch (error) {
        if (error instanceof BodyLimitError)
          throw new CliInputError(`${label} JSON must be at most 64 KB.`);
        throw error;
      }
    }
  } else {
    const fileHandle = await open(
      resolve(context.cwd, file),
      constants.O_RDONLY | constants.O_NONBLOCK
    );
    try {
      if (!(await fileHandle.stat()).isFile())
        throw new CliInputError(`${label} file must be a regular file.`);
      const buffer = Buffer.alloc(CLI_INPUT_MAX_BYTES + 1);
      let size = 0;
      while (size < buffer.length) {
        if (context.signal.aborted) throw new Error("Input read interrupted.");
        const read = await fileHandle.read(buffer, size, buffer.length - size, null);
        if (read.bytesRead === 0) break;
        size += read.bytesRead;
      }
      text = buffer.subarray(0, size).toString("utf8");
    } finally {
      await fileHandle.close();
    }
  }
  return parseCliJson(text, label);
}

export function parseCliJson(text: string, label: string): unknown {
  if (Buffer.byteLength(text) > CLI_INPUT_MAX_BYTES)
    throw new CliInputError(`${label} JSON must be at most 64 KB.`);
  try {
    return JSON.parse(text);
  } catch {
    throw new CliInputError(`${label} must be valid JSON.`);
  }
}
