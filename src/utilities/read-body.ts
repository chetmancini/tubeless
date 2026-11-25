import { awaitWithAbort, throwIfAborted } from "./abort.js";

export class BodyLimitError extends Error {
  constructor() {
    super("Body exceeds its byte limit.");
  }
}

/** Discard a stream or reader without letting cleanup delay or replace the outcome. */
export function cancelBody(body: { cancel(): Promise<void> } | null): void {
  // oxlint-disable-next-line landmines/no-silent-catch -- An errored stream also rejects cancellation.
  void body?.cancel().catch(() => {});
}

async function* readBodyChunks(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal
): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  try {
    for (;;) {
      throwIfAborted(signal, "Body read");
      const pending = reader.read();
      const chunk = signal ? await awaitWithAbort(pending, signal, "Body read") : await pending;
      throwIfAborted(signal, "Body read");
      if (chunk.done) return;
      yield chunk.value;
    }
  } finally {
    cancelBody(reader);
    reader.releaseLock();
  }
}

/** Consume byte chunks in order, waiting for the consumer before reading again. */
export async function consumeBody(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal | undefined,
  consume: (chunk: Uint8Array) => void | Promise<void>
): Promise<void> {
  for await (const chunk of readBodyChunks(body, signal)) {
    const consumed = consume(chunk);
    if (consumed) await consumed;
  }
}

/** Read owned bytes with bounded allocation; cancellation never waits on an untrusted source. */
export async function readBoundedBody(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  signal?: AbortSignal
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error("Invalid body limit.");
  if (!body) return new Uint8Array();
  const bytes = new Uint8Array(maxBytes);
  let size = 0;
  await consumeBody(body, signal, (chunk) => {
    if (chunk.byteLength > maxBytes - size) throw new BodyLimitError();
    bytes.set(chunk, size);
    size += chunk.byteLength;
  });
  throwIfAborted(signal, "Body read");
  return bytes.subarray(0, size);
}

export class NdjsonFormatError extends Error {
  constructor(cause?: unknown) {
    super("Invalid NDJSON stream.", { cause });
  }
}

/** Decode complete records and discard a partial record if the connection ends. */
export async function* readNdjson(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  maxLineBytes: number,
  maxStreamBytes: number
): AsyncGenerator<unknown> {
  const line = new Uint8Array(maxLineBytes);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0;
  let total = 0;
  for await (const chunk of readBodyChunks(body, signal)) {
    total += chunk.byteLength;
    if (total > maxStreamBytes) throw new NdjsonFormatError();
    for (let start = 0; start < chunk.length;) {
      const newline = chunk.indexOf(10, start);
      const end = newline === -1 ? chunk.length : newline;
      if (size + end - start >= line.length) throw new NdjsonFormatError();
      line.set(chunk.subarray(start, end), size);
      size += end - start;
      if (newline === -1) break;
      let value: unknown;
      try {
        value = JSON.parse(decoder.decode(line.subarray(0, size)));
      } catch (error) {
        throw new NdjsonFormatError(error);
      }
      yield value;
      size = 0;
      start = newline + 1;
    }
  }
}
