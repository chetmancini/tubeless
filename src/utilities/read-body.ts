import { awaitWithAbort, throwIfAborted } from "./abort.js";

export class BodyLimitError extends Error {
  constructor() {
    super("Body exceeds its byte limit.");
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
  const reader = body.getReader();
  let size = 0;
  try {
    for (;;) {
      throwIfAborted(signal, "Body read");
      const pending = reader.read();
      const chunk = signal ? await awaitWithAbort(pending, signal, "Body read") : await pending;
      if (chunk.done) break;
      if (chunk.value.byteLength > maxBytes - size) throw new BodyLimitError();
      bytes.set(chunk.value, size);
      size += chunk.value.byteLength;
    }
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  throwIfAborted(signal, "Body read");
  return bytes.subarray(0, size);
}
