import { throwIfAborted } from "../utilities/abort.js";

export const MAX_REQUEST_BYTES = 1_048_576;
const MAX_RESPONSE_BYTES = 2_097_152;

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
    await response.body?.cancel().catch(() => {});
    throw new Error(`OpenAI ${endpoint} failed (HTTP ${response.status})`);
  }
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
      if (bytes > MAX_RESPONSE_BYTES) throw new Error("OpenAI response exceeds 2 MiB");
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
