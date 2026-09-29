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
  const share = Math.floor(budget / outputs.length) - 1;
  return outputs.map((item, index) => {
    if (encodedBytes(item) <= share) return item;
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
    let bounded = preview(0);
    if (encodedBytes(bounded) > share)
      throw new Error("OpenAI request has no room for tool output metadata");
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
