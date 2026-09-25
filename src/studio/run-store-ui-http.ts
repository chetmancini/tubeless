import { isIP } from "node:net";

/** Format a host literal for an HTTP URL or authority. */
export function formatHttpUrlHost(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}

/** Normalize a bare HTTP authority, including omission of the default port. */
export function normalizeHttpAuthority(authority: string | undefined): string | undefined {
  if (!authority || /[\s\\/@?#]/.test(authority)) return undefined;
  try {
    const parsed = new URL(`http://${authority}/`);
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

/** Hostname that a wildcard listener may trust: localhost or a literal IP. */
export function isLiteralOrLocalhostHttpHost(hostname: string): boolean {
  const value = hostname.toLowerCase();
  const unbracketed = value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
  return unbracketed === "localhost" || isIP(unbracketed) !== 0;
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

export function writeJson(
  response: import("node:http").ServerResponse,
  value: unknown,
  status = 200
): void {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(value));
}

export function writeError(
  response: import("node:http").ServerResponse,
  status: number,
  code: string,
  message: string,
  hint: string
): void {
  writeJson(response, { code, hint, message }, status);
}

export async function readJsonBody(request: import("node:http").IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let byteLength = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    byteLength += buffer.byteLength;
    if (byteLength > 65_536) {
      throw new StudioRequestError(
        "request_body_too_large",
        "Request body exceeds 64 KiB.",
        413,
        "Send a JSON body no larger than 64 KiB."
      );
    }
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new StudioRequestError(
      "invalid_json",
      "Request body must be valid JSON.",
      400,
      "Send a valid JSON object with content-type application/json."
    );
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

export function writeUnexpectedStudioError(
  response: import("node:http").ServerResponse,
  error: unknown
): void {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  writeError(
    response,
    500,
    "studio_internal_error",
    "The studio hit an unexpected error.",
    "Inspect the local Studio process logs and retry after fixing the reported cause."
  );
}
