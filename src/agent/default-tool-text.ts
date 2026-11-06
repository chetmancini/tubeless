import { MAX_OUTPUT_BYTES } from "./default-tool-limits.js";

export function clippedText(text: string, maxBytes = MAX_OUTPUT_BYTES) {
  const bytes = Buffer.from(text);
  return {
    text: new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes.subarray(0, maxBytes), {
      stream: bytes.length > maxBytes,
    }),
    truncated: bytes.length > maxBytes,
  };
}
