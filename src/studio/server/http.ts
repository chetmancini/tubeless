import { BodyLimitError, readBoundedBody } from "../../utilities/read-body.js";
import { jsonResponse } from "../../utilities/http-response.js";

/** Format a host literal for an HTTP URL or authority. */
export function formatHttpUrlHost(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}

/** Normalize a bare HTTP authority, including omission of the default port. */
export function normalizeHttpAuthority(
  authority: string | undefined,
  protocol = "http:"
): string | undefined {
  if (!authority || /[\s\\/@?#]/.test(authority)) return undefined;
  try {
    const parsed = new URL(`${protocol}//${authority}/`);
    if (parsed.username || parsed.password || parsed.pathname !== "/") return undefined;
    return parsed.host.toLowerCase();
  } catch {
    return undefined;
  }
}

/** True for bind addresses that cannot appear in a client Host header. */
export function isUnspecifiedHttpHost(host: string): boolean {
  return host === "0.0.0.0" || host === "::";
}

/** Split a normalized authority into hostname and port (empty port = default). */
export function parseHttpAuthority(
  authority: string | undefined
): { hostname: string; port: string } | undefined {
  const normalized = normalizeHttpAuthority(authority);
  if (!normalized) return undefined;
  try {
    const parsed = new URL(`http://${normalized}/`);
    const hostname = parsed.hostname.startsWith("[")
      ? parsed.hostname.slice(1, -1)
      : parsed.hostname;
    return { hostname, port: parsed.port };
  } catch {
    return undefined;
  }
}

export class StudioRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly hint: string
  ) {
    super(message);
  }
}

export function decodePathSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new StudioRequestError(
      "malformed_path_segment",
      "Malformed path segment.",
      400,
      "Percent-encode the path segment as valid UTF-8."
    );
  }
}

const MAX_REQUEST_BODY_BYTES = 65_536;

export function errorResponse(
  status: number,
  code: string,
  message: string,
  hint: string
): Response {
  return jsonResponse({ code, hint, message }, status);
}

/** Read at most 64 KiB of JSON without assuming a runtime-specific body helper. */
export async function readJsonBody(request: Request): Promise<unknown> {
  let bytes: Uint8Array;
  try {
    bytes = await readBoundedBody(request.body, MAX_REQUEST_BODY_BYTES, request.signal);
  } catch (error) {
    if (!(error instanceof BodyLimitError)) throw error;
    throw new StudioRequestError(
      "request_body_too_large",
      "Request body exceeds 64 KiB.",
      413,
      "Send a JSON body no larger than 64 KiB."
    );
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new StudioRequestError(
      "invalid_json",
      "Request body must be valid JSON.",
      400,
      "Send a valid JSON object with content-type application/json."
    );
  }
}

export function unexpectedStudioErrorResponse(error: unknown): Response {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  return errorResponse(
    500,
    "studio_internal_error",
    "The studio hit an unexpected error.",
    "Inspect the local Studio process logs and retry after fixing the reported cause."
  );
}
