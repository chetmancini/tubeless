import {
  BodyLimitError,
  cancelBody,
  consumeBody,
  readBoundedBody,
} from "../../utilities/read-body.js";
import {
  parseReproductionManifest,
  REPRODUCTION_MANIFEST_MAX_BYTES,
} from "../../utilities/reproduction-manifest.js";
import { errorMessage } from "../workbench-shared.js";
import { CloudClientError } from "./protocol.js";

const RESPONSE_LIMIT = 4 * 1024 * 1024;

export async function responseJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    cancelBody(response.body);
    throw new CloudClientError(
      "Cloud returned a non-JSON response.",
      "invalid_response",
      response.status
    );
  }
  if (Number(response.headers.get("content-length")) > RESPONSE_LIMIT) {
    cancelBody(response.body);
    throw new CloudClientError(
      "Cloud response exceeds the size limit.",
      "invalid_response",
      response.status
    );
  }
  if (!response.body) {
    throw new CloudClientError(
      "Cloud returned an empty response.",
      "invalid_response",
      response.status
    );
  }
  try {
    const bytes = await readBoundedBody(response.body, RESPONSE_LIMIT, signal);
    const body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(body) as unknown;
  } catch (error) {
    if (error instanceof BodyLimitError)
      throw new CloudClientError(
        "Cloud response exceeds the size limit.",
        "invalid_response",
        response.status
      );
    throw new CloudClientError("Cloud returned invalid JSON.", "invalid_response", response.status);
  }
}

export async function writeArtifact(
  body: ReadableStream<Uint8Array> | null,
  signal: AbortSignal,
  write: (bytes: Uint8Array) => Promise<void>,
  refreshTimeout: () => void
): Promise<void> {
  if (!body) return;
  refreshTimeout();
  await consumeBody(body, signal, (chunk) => {
    if (chunk.byteLength > 0) refreshTimeout();
    return write(chunk);
  }).catch((error: unknown) => {
    if (error instanceof CloudClientError) throw error;
    throw new CloudClientError("Cloud artifact transfer was interrupted.", "transport_error");
  });
}

export async function readManifest(
  response: Response,
  runId: string,
  signal: AbortSignal
): Promise<Uint8Array> {
  const limit = REPRODUCTION_MANIFEST_MAX_BYTES;
  const oversized = "Reproduction manifest exceeds 64 KiB.";
  if (Number(response.headers.get("content-length")) > limit) {
    cancelBody(response.body);
    throw new CloudClientError(oversized, "invalid_response");
  }
  const bytes = await readBoundedBody(response.body, limit, signal).catch((error: unknown) => {
    if (error instanceof BodyLimitError) throw new CloudClientError(oversized, "invalid_response");
    throw new CloudClientError("Cloud manifest transfer was interrupted.", "transport_error");
  });
  const manifest = await parseReproductionManifest(bytes).catch((error: unknown) => {
    throw new CloudClientError(errorMessage(error), "invalid_response");
  });
  if (manifest.run.id !== runId)
    throw new CloudClientError(
      "Cloud returned a manifest for a different run.",
      "invalid_response"
    );
  return bytes;
}
