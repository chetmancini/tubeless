import { abortableSleep, throwIfAborted } from "../utilities/abort.js";

export const MAX_REQUEST_BYTES = 1_048_576;
// Leave room for the next result batch without rewriting small, reusable histories.
export const DEFAULT_COMPACT_AFTER_BYTES = 786_432;
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

/** Read a bounded JSON body. The caller labels abort and size errors with `provider`. */
export async function readProviderJson(
  response: Response,
  signal: AbortSignal,
  maxBytes: number,
  provider: string
): Promise<unknown> {
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
      if (bytes > maxBytes) throw new Error(`${provider} response exceeds ${maxBytes} bytes`);
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

/** A failed provider HTTP exchange; `retryable` marks rate limits, timeouts, server errors and network failures. */
export class ProviderRequestError extends Error {
  readonly status: number | undefined;
  readonly retryable: boolean;
  readonly retryAfterMs: number | undefined;
  constructor(
    message: string,
    details: { status?: number; retryable: boolean; retryAfterMs?: number; cause?: unknown }
  ) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = "ProviderRequestError";
    this.status = details.status;
    this.retryable = details.retryable;
    this.retryAfterMs = details.retryAfterMs;
  }
}

/** Read `Retry-After` from a failed response. Never throws; an unusable value stays unknown. */
function retryAfterMs(headers: Headers, now = Date.now()): number | undefined {
  const milliseconds = headers.get("retry-after-ms");
  if (milliseconds !== null) {
    const parsed = Number(milliseconds.trim());
    if (Number.isFinite(parsed) && parsed >= 0) return Math.ceil(parsed);
  }
  const header = headers.get("retry-after");
  if (header === null) return undefined;
  const value = header.trim();
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

/**
 * POST bounded JSON to a model provider.
 * `onHttpError` owns the body and returns text appended to the status error.
 * Without it, the body is discarded so provider text never reaches diagnostics.
 */
export async function providerRequest(
  provider: string,
  endpoint: string,
  url: string,
  headers: Readonly<Record<string, string>>,
  payload: object,
  signal: AbortSignal,
  onHttpError?: (response: Response) => Promise<string>
): Promise<unknown> {
  const body = JSON.stringify(payload);
  if (Buffer.byteLength(body) > MAX_REQUEST_BYTES)
    throw new Error(`${provider} request exceeds 1 MiB`);
  throwIfAborted(signal, `${provider} request`);
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      redirect: "manual",
      headers: { ...headers, "Content-Type": "application/json" },
      signal,
      body,
    });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new ProviderRequestError(`${provider} ${endpoint} failed (network error)`, {
      retryable: true,
      cause: error,
    });
  }
  if (!response.ok) {
    const extra = onHttpError ? await onHttpError(response) : "";
    if (!onHttpError) await response.body?.cancel().catch(() => {});
    const status = response.status;
    throw new ProviderRequestError(`${provider} ${endpoint} failed (HTTP ${status})${extra}`, {
      status,
      retryable: status === 408 || status === 429 || (status >= 500 && status <= 599),
      retryAfterMs: retryAfterMs(response.headers),
    });
  }
  return readProviderJson(response, signal, MAX_RESPONSE_BYTES, provider);
}

/**
 * Run provider work under the caller's signal plus a deadline. Caller aborts stay
 * cancellations; a deadline alone becomes an ordinary failure, as in MCP sessions.
 * `remainingMs` lets the work refuse a backoff wait that outlives the deadline.
 */
export async function withProviderDeadline<T>(
  label: string,
  timeoutMs: number,
  caller: AbortSignal | undefined,
  work: (signal: AbortSignal, remainingMs: () => number) => Promise<T>
): Promise<T> {
  const deadline = AbortSignal.timeout(timeoutMs);
  const signal = caller ? AbortSignal.any([caller, deadline]) : deadline;
  const started = performance.now();
  try {
    return await work(signal, () => timeoutMs - (performance.now() - started));
  } catch (error) {
    if (!caller?.aborted && deadline.aborted)
      throw new Error(`${label} timed out after ${timeoutMs} ms`);
    throw error;
  }
}

export const DEFAULT_MAX_RETRIES = 2;
export const MAX_RETRIES_LIMIT = 10;
const BASE_RETRY_DELAY_MS = 500;
const MAX_BACKOFF_MS = 8_000;
const MAX_RETRY_WAIT_MS = 60_000;

/** Retry retryable ProviderRequestErrors with backoff, inside the caller's signal and deadline. */
export async function withProviderRetry<T>(
  options: {
    maxRetries: number;
    signal: AbortSignal;
    remainingMs: () => number;
    /** For example "OpenAI decision"; used in the abort label and the log line. */
    label: string;
    log?: (message: string) => void;
    random?: () => number;
    sleep?: (durationMs: number, signal: AbortSignal) => Promise<void>;
  },
  attempt: () => Promise<T>
): Promise<T> {
  for (let retry = 0; ; retry++) {
    try {
      return await attempt();
    } catch (error) {
      if (
        !(error instanceof ProviderRequestError) ||
        !error.retryable ||
        retry >= options.maxRetries ||
        options.signal.aborted
      )
        throw error;
      const base = error.retryAfterMs ?? Math.min(BASE_RETRY_DELAY_MS * 2 ** retry, MAX_BACKOFF_MS);
      const delayMs = Math.ceil(base + (options.random ?? Math.random)() * base * 0.25);
      // Fail now with the real cause instead of sleeping into a timeout.
      if (delayMs > MAX_RETRY_WAIT_MS || delayMs >= options.remainingMs()) throw error;
      const reason = error.status === undefined ? "network error" : `HTTP ${error.status}`;
      options.log?.(
        `${options.label} failed (${reason}); retrying in ${delayMs} ms (retry ${retry + 1} of ${options.maxRetries})`
      );
      const sleep = options.sleep ?? ((ms, signal) => abortableSleep(ms, signal, options.label));
      await sleep(delayMs, options.signal);
    }
  }
}
