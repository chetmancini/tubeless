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
  const reader = body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      throwIfAborted(signal, "Body read");
      const pending = reader.read();
      const chunk = signal ? await awaitWithAbort(pending, signal, "Body read") : await pending;
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maxBytes) throw new BodyLimitError();
      chunks.push(new Uint8Array(chunk.value));
    }
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  throwIfAborted(signal, "Body read");
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
