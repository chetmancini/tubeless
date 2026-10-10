import { throwIfAborted } from "../utilities/abort.js";
import { record } from "./openai-protocol.js";

export const MAX_REQUEST_BYTES = 1_048_576;
const MAX_RESPONSE_BYTES = 2_097_152;
const MAX_ERROR_RESPONSE_BYTES = 16_384;

async function readResponse(
  response: Response,
  signal: AbortSignal,
  maxBytes: number
): Promise<unknown> {
  if (!response.body) throw new Error("OpenAI returned an empty response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      throwIfAborted(signal, "OpenAI response");
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) throw new Error(`OpenAI response exceeds ${maxBytes} bytes`);
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  throwIfAborted(signal, "OpenAI response");
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("OpenAI returned invalid JSON");
  }
}

async function authenticationFailure(response: Response, signal: AbortSignal): Promise<string> {
  let body: unknown;
  try {
    body = await readResponse(response, signal, MAX_ERROR_RESPONSE_BYTES);
  } catch {
    throwIfAborted(signal, "OpenAI response");
    // A missing, malformed, oversized or unreadable error body does not hide the HTTP status.
  }
  const code = record(body) && record(body.error) ? body.error.code : undefined;
  // Never print raw error.message or unknown codes: providers may echo API keys in them.
  if (code === "invalid_api_key")
    return "[invalid_api_key] The API key was rejected. Use an active API key from the correct OpenAI project.";
  if (code === "ip_not_authorized")
    return "[ip_not_authorized] Your IP is not on the project's or organization's allowlist. Use an allowed network or update the OpenAI IP allowlist.";
  return "Authentication was rejected. Check that the API key is active, its project and organization are accessible, and your IP is allowed.";
}

export async function openaiRequest(
  endpoint: "responses" | "responses/compact",
  payload: object,
  apiKey: string | undefined,
  signal: AbortSignal
): Promise<unknown> {
  const body = JSON.stringify(payload);
  if (Buffer.byteLength(body) > MAX_REQUEST_BYTES) throw new Error("OpenAI request exceeds 1 MiB");
  throwIfAborted(signal, "OpenAI request");
  const key = (apiKey ?? process.env.OPENAI_API_KEY)?.trim();
  if (!key) throw new Error("OPENAI_API_KEY is required for live model execution");
  const response = await fetch(`https://api.openai.com/v1/${endpoint}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    signal,
    body,
  });
  if (!response.ok) {
    const advice = response.status === 401 ? await authenticationFailure(response, signal) : "";
    if (response.status !== 401) await response.body?.cancel().catch(() => {});
    const requestId = response.headers.get("x-request-id");
    const request =
      requestId && /^req_[A-Za-z0-9_-]{1,128}$/.test(requestId) && !requestId.includes(key)
        ? ` Request ID: ${requestId}.`
        : "";
    throw new Error(
      `OpenAI ${endpoint} failed (HTTP ${response.status})${advice ? `: ${advice}` : ""}${request}`
    );
  }
  return readResponse(response, signal, MAX_RESPONSE_BYTES);
}
