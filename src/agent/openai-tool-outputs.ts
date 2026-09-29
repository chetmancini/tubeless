import type { AgentModelRequest } from "./model-types.js";

const MAX_BATCH_BYTES = 262_144;
const encodedBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

/** Bound provider-visible results, including outer JSON escaping and item separators. */
export function openaiToolOutputs(outcomes: AgentModelRequest["outcomes"], availableBytes: number) {
  const outputs = outcomes.map((outcome) => ({
    type: "function_call_output" as const,
    call_id: outcome.id,
    output: JSON.stringify(
      outcome.ok ? { ok: true, value: outcome.value } : { ok: false, error: outcome.error }
    ),
  }));
  const budget = Math.min(MAX_BATCH_BYTES, availableBytes);
  if (
    outputs.length === 0 ||
    outputs.reduce((bytes, item) => bytes + encodedBytes(item) + 1, 0) <= budget
  )
    return outputs;
  const entries = outputs.map((item, index) => {
    const bytes = Buffer.from(item.output);
    const preview = (length: number) => ({
      ...item,
      output: JSON.stringify({
        ok: outcomes[index]!.ok,
        truncated: true,
        originalBytes: bytes.length,
        preview: new TextDecoder().decode(bytes.subarray(0, length), { stream: true }),
        notice:
          "Result truncated for model context. Retrieve narrower results; do not repeat successful mutations.",
      }),
    });
    const marker = preview(0);
    // Small complete results can cost less than a truncation marker.
    const minimum = encodedBytes(item) <= encodedBytes(marker) ? item : marker;
    return { item, bytes, preview, minimum, minimumBytes: encodedBytes(minimum) + 1 };
  });
  const remaining = budget - entries.reduce((total, entry) => total + entry.minimumBytes, 0);
  if (remaining < 0) throw new Error("OpenAI request has no room for tool output metadata");
  // The full batch did not fit, so at least one entry must still need a preview.
  const previewCount = entries.filter((entry) => entry.minimum !== entry.item).length;
  const extra = Math.floor(remaining / previewCount);
  return entries.map(({ item, bytes, preview, minimum, minimumBytes }) => {
    if (minimum === item) return item;
    const share = minimumBytes - 1 + extra;
    if (encodedBytes(item) <= share) return item;
    let bounded = minimum;
    let low = 0;
    let high = bytes.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      const candidate = preview(middle);
      if (encodedBytes(candidate) <= share) {
        low = middle;
        bounded = candidate;
      } else high = middle - 1;
    }
    return bounded;
  });
}
