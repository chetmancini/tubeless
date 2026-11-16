import { awaitWithAbort, throwIfAborted } from "../utilities/abort.js";
import { MAX_RESPONSE_BYTES } from "./provider-http.js";
import { record } from "./provider-schema.js";

const MAX_EVENT_BYTES = MAX_RESPONSE_BYTES + 4096;

/** Yield bounded SSE data fields; consumers own JSON decoding and protocol completion. */
export async function* readProviderEvents(
  response: Response,
  signal: AbortSignal,
  provider: string
): AsyncGenerator<string> {
  if (
    !response.body ||
    !response.headers.get("content-type")?.toLowerCase().includes("text/event-stream")
  ) {
    void response.body?.cancel().catch(() => {});
    throw new Error(`${provider} did not return an event stream`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  let data: string[] = [];
  let eventBytes = 0;
  let bytes = 0;
  let events = 0;
  let firstLine = true;
  let afterCR = false;
  // Grow one bounded line buffer instead of rescanning/concatenating an unfinished
  // JSON line on every network chunk (which is quadratic with small chunks).
  let buffer = new Uint8Array(4096);
  let length = 0;
  const line = (): string | undefined => {
    let value: string;
    try {
      value = decoder.decode(buffer.subarray(0, length));
    } catch {
      throw new Error(`${provider} stream contains invalid UTF-8`);
    }
    length = 0;
    if (firstLine) value = value.replace(/^\uFEFF/, "");
    firstLine = false;
    if (value === "") {
      eventBytes = 0;
      if (!data.length) return;
      if (++events > 65_536) throw new Error(`${provider} stream has too many events`);
      const raw = data.join("\n");
      data = [];
      return raw;
    }
    eventBytes += Buffer.byteLength(value);
    if (eventBytes > MAX_EVENT_BYTES) throw new Error(`${provider} stream event exceeds 2 MiB`);
    if (value.startsWith("data:")) data.push(value.slice(5).replace(/^ /, ""));
  };
  try {
    while (true) {
      throwIfAborted(signal, `${provider} stream`);
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await awaitWithAbort(reader.read(), signal, `${provider} stream`);
      } catch {
        throwIfAborted(signal, `${provider} stream`);
        throw new Error(`${provider} stream interrupted`);
      }
      if (chunk.done) {
        // Validate any unterminated line too, but EOF never establishes completion.
        if (length) {
          try {
            decoder.decode(buffer.subarray(0, length));
          } catch {
            throw new Error(`${provider} stream contains invalid UTF-8`);
          }
        }
        break;
      }
      bytes += chunk.value.byteLength;
      if (bytes > 16_777_216) throw new Error(`${provider} stream exceeds 16 MiB`);
      for (const byte of chunk.value) {
        if (afterCR && byte === 10) {
          afterCR = false;
          continue;
        }
        afterCR = byte === 13;
        if (byte === 10 || byte === 13) {
          const event = line();
          if (event !== undefined) {
            yield event;
            throwIfAborted(signal, `${provider} stream`);
          }
          continue;
        }
        if (length + eventBytes >= MAX_EVENT_BYTES)
          throw new Error(`${provider} stream event exceeds 2 MiB`);
        if (length === buffer.length) {
          const grown = new Uint8Array(Math.min(buffer.length * 2, MAX_EVENT_BYTES));
          grown.set(buffer);
          buffer = grown;
        }
        buffer[length++] = byte;
      }
    }
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Decode an untrusted event without forwarding provider text in parse errors. */
export function parseProviderEvent(data: string, provider: string): Record<string, unknown> {
  let event: unknown;
  try {
    event = JSON.parse(data);
  } catch {
    throw new Error(`${provider} stream contains invalid JSON`);
  }
  if (!record(event)) throw new Error(`${provider} stream contains an invalid event`);
  return event;
}
