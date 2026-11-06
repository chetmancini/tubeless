import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import * as path from "node:path";
import { awaitWithAbort } from "../../utilities/abort.js";
import {
  CloudClientError,
  parseCloudSource,
  CLOUD_INPUT_MAX_DEPTH,
  CLOUD_INPUT_MAX_BYTES,
  isCloudJsonValue,
  isCloudIdempotencyKey,
  type CliRunRequest,
  type CloudJsonValue,
} from "./protocol.js";

export interface CloudRunInputArguments {
  "input-file"?: string;
  source?: string;
  ref?: string;
  "idempotency-key"?: string;
}

export interface CloudRunInputContext {
  cwd: string;
  signal: AbortSignal;
  readStdin?: () => Promise<string>;
}

export interface PreparedCloudRunInput {
  readonly input: CliRunRequest["input"];
  readonly source?: CliRunRequest["source"];
  readonly idempotencyKey: string;
}

/** Argument combinations report usage errors, independently of invalid JSON/data. */
export class CloudRunUsageError extends Error {}

/** Resolve CLI input transports once, before credentials or network activity. */
export async function prepareRunInput(
  args: CloudRunInputArguments,
  context: CloudRunInputContext
): Promise<PreparedCloudRunInput> {
  if (args["input-file"] === "")
    throw new CloudRunUsageError("Pass a nonempty --input-file path, or - for stdin.");
  if (args.source === "" || args.source === "@")
    throw new CloudRunUsageError("Pass --source as JSON, @path, or - for stdin.");
  if (args.ref === "")
    throw new CloudRunUsageError("Pass a nonempty GitHub branch, tag or commit with --ref.");
  if (args.ref !== undefined && args.source !== undefined)
    throw new CloudRunUsageError("Choose --ref or --source, not both.");
  if (args["input-file"] === "-" && args.source === "-")
    throw new CloudRunUsageError("Only one of --input-file and --source may read stdin.");
  if (args["idempotency-key"] !== undefined && !isCloudIdempotencyKey(args["idempotency-key"]))
    throw new CloudClientError(
      "Invalid Cloud run idempotency key. Use 1–200 letters, digits, periods, underscores, colons or hyphens.",
      "invalid_request"
    );

  let source: CliRunRequest["source"];
  if (args.ref !== undefined) {
    source = parseCloudSource({ kind: "ref", ref: args.ref });
  } else if (args.source !== undefined) {
    const argument = args.source;
    let value: unknown;
    if (argument === "-") value = await boundedInput("-", context, "Source");
    else if (argument.startsWith("@"))
      value = await boundedInput(path.resolve(context.cwd, argument.slice(1)), context, "Source");
    else value = parseJsonObject(argument, "Source");
    source = parseCloudSource(value);
  }
  const input =
    args["input-file"] === undefined
      ? {}
      : await boundedInput(args["input-file"], context, "Input");
  return {
    input,
    ...(source ? { source } : {}),
    idempotencyKey: args["idempotency-key"] ?? randomUUID(),
  };
}

async function boundedInput(
  file: string,
  context: CloudRunInputContext,
  label: "Input" | "Source"
): Promise<Record<string, CloudJsonValue>> {
  let text: string;
  if (file === "-") {
    if (context.readStdin)
      text = await awaitWithAbort(context.readStdin(), context.signal, "Input read");
    else {
      text = await new Promise<string>((resolve, reject) => {
        const chunks: Buffer[] = [];
        let size = 0;
        const cleanup = () => {
          process.stdin.off("data", onData);
          process.stdin.off("end", onEnd);
          process.stdin.off("error", onError);
          context.signal.removeEventListener("abort", onAbort);
          process.stdin.pause();
        };
        const onError = (error: Error) => {
          cleanup();
          reject(error);
        };
        const onAbort = () => onError(new Error("Input read interrupted."));
        const onData = (chunk: Buffer | string) => {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += bytes.length;
          if (size > CLOUD_INPUT_MAX_BYTES) {
            onError(
              new CloudClientError(`${label} JSON must be at most 64 KB.`, "invalid_request")
            );
            return;
          }
          chunks.push(bytes);
        };
        const onEnd = () => {
          cleanup();
          resolve(Buffer.concat(chunks).toString("utf8"));
        };
        process.stdin.on("data", onData);
        process.stdin.once("end", onEnd);
        process.stdin.once("error", onError);
        context.signal.addEventListener("abort", onAbort, { once: true });
        if (context.signal.aborted) onAbort();
        else process.stdin.resume();
      });
    }
  } else {
    const fileHandle = await open(
      path.resolve(context.cwd, file),
      constants.O_RDONLY | constants.O_NONBLOCK
    );
    try {
      if (!(await fileHandle.stat()).isFile())
        throw new CloudClientError(`${label} file must be a regular file.`, "invalid_request");
      const buffer = Buffer.alloc(CLOUD_INPUT_MAX_BYTES + 1);
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
  return parseJsonObject(text, label);
}

function parseJsonObject(text: string, label: string): Record<string, CloudJsonValue> {
  if (Buffer.byteLength(text) > CLOUD_INPUT_MAX_BYTES)
    throw new CloudClientError(`${label} JSON must be at most 64 KB.`, "invalid_request");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new CloudClientError(`${label} must be valid JSON.`, "invalid_request");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new CloudClientError(`${label} must be a JSON object.`, "invalid_request");
  if (!isCloudJsonValue(value))
    throw new CloudClientError(
      `${label} must contain JSON data with finite numbers and at most ${CLOUD_INPUT_MAX_DEPTH} levels of objects and arrays.`,
      "invalid_request"
    );
  // SAFETY: The object shape and every JSON value were checked above.
  return value as Record<string, CloudJsonValue>;
}
