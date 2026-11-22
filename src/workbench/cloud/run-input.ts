import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { isJsonObject } from "../../utilities/canonical-json.js";
import {
  CliInputError,
  parseCliJson,
  readCliJson,
  type CliInputContext,
} from "../workbench-json-input.js";
import {
  CloudClientError,
  parseCloudSource,
  CLOUD_INPUT_MAX_DEPTH,
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
  context: CliInputContext
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

  try {
    let source: CliRunRequest["source"];
    if (args.ref !== undefined) {
      source = parseCloudSource({ kind: "ref", ref: args.ref });
    } else if (args.source !== undefined) {
      const argument = args.source;
      const value =
        argument === "-"
          ? await readCliJson("-", context, "Source")
          : argument.startsWith("@")
            ? await readCliJson(resolve(context.cwd, argument.slice(1)), context, "Source")
            : parseCliJson(argument, "Source");
      source = parseCloudSource(cloudJsonObject(value, "Source"));
    }
    const input =
      args["input-file"] === undefined
        ? {}
        : cloudJsonObject(await readCliJson(args["input-file"], context, "Input"), "Input");
    return {
      input,
      ...(source ? { source } : {}),
      idempotencyKey: args["idempotency-key"] ?? randomUUID(),
    };
  } catch (error) {
    if (error instanceof CliInputError)
      throw new CloudClientError(error.message, "invalid_request");
    throw error;
  }
}

function cloudJsonObject(value: unknown, label: string): Record<string, CloudJsonValue> {
  if (!isJsonObject(value))
    throw new CloudClientError(`${label} must be a JSON object.`, "invalid_request");
  if (!isCloudJsonValue(value))
    throw new CloudClientError(
      `${label} must contain JSON data with finite numbers and at most ${CLOUD_INPUT_MAX_DEPTH} levels of objects and arrays.`,
      "invalid_request"
    );
  return value;
}
