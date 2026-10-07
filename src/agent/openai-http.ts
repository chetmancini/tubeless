import { providerBaseUrl, providerRequest } from "./provider-http.js";

export { MAX_REQUEST_BYTES } from "./provider-http.js";

const DEFAULT_BASE_URL = "https://api.openai.com/v1";

export async function openaiRequest(
  endpoint: "responses" | "responses/compact",
  payload: object,
  apiKey: string | undefined,
  signal: AbortSignal,
  baseUrl?: string
): Promise<unknown> {
  const key = (apiKey ?? process.env.OPENAI_API_KEY)?.trim();
  if (!key) throw new Error("OPENAI_API_KEY is required for live model execution");
  const base = providerBaseUrl(
    "OpenAI",
    baseUrl ?? (process.env.OPENAI_BASE_URL?.trim() || DEFAULT_BASE_URL)
  );
  return providerRequest(
    "OpenAI",
    endpoint,
    `${base}/${endpoint}`,
    { Authorization: `Bearer ${key}` },
    payload,
    signal
  );
}
