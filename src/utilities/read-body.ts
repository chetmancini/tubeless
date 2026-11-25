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

/** Consume byte chunks in order, waiting for the consumer before reading again. */
export async function consumeBody(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal | undefined,
  consume: (chunk: Uint8Array) => void | Promise<void>
): Promise<void> {
  const reader = body.getReader();
  try {
    for (;;) {
      throwIfAborted(signal, "Body read");
      const pending = reader.read();
      const chunk = signal ? await awaitWithAbort(pending, signal, "Body read") : await pending;
      throwIfAborted(signal, "Body read");
      if (chunk.done) return;
      const consumed = consume(chunk.value);
      if (consumed) await consumed;
    }
  } finally {
    cancelBody(reader);
    reader.releaseLock();
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
