import { throwIfAborted } from "../utilities/abort.js";

export const MAX_REQUEST_BYTES = 1_048_576;
const MAX_RESPONSE_BYTES = 2_097_152;

/** Resolve an http(s) base URL without a trailing slash, or throw a provider-labelled error. */
export function providerBaseUrl(provider: string, value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error(`Invalid ${provider} base URL`);
  }
  // Endpoints are appended to the path, so a query or fragment would swallow them.
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.search || url.hash)
    throw new Error(`Invalid ${provider} base URL`);
  return url.href.replace(/\/+$/, "");
}

export function isBaseUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    providerBaseUrl("", value);
    return true;
  } catch {
    return false;
  }
}

/** POST bounded JSON to a model provider; error bodies never reach diagnostics. */
export async function providerRequest(
  provider: string,
  endpoint: string,
  url: string,
  headers: Readonly<Record<string, string>>,
  payload: object,
  signal: AbortSignal
): Promise<unknown> {
  const body = JSON.stringify(payload);
  if (Buffer.byteLength(body) > MAX_REQUEST_BYTES)
    throw new Error(`${provider} request exceeds 1 MiB`);
  throwIfAborted(signal, `${provider} request`);
  const response = await fetch(url, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    signal,
    body,
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`${provider} ${endpoint} failed (HTTP ${response.status})`);
  }
  if (!response.body) throw new Error(`${provider} returned an empty response`);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      throwIfAborted(signal, `${provider} response`);
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new Error(`${provider} response exceeds 2 MiB`);
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  throwIfAborted(signal, `${provider} response`);
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error(`${provider} returned invalid JSON`);
  }
}
