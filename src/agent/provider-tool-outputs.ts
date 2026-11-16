import type { AgentModelRequest } from "./model-types.js";
import { utf8ByteLength, utf8Bytes } from "./provider-utf8.js";
import { MAX_TOOL_OUTPUT_BYTES } from "./provider-limits.js";

type Outcome = AgentModelRequest["outcomes"][number];

const encodedBytes = (value: unknown) => utf8ByteLength(JSON.stringify(value));

export function boundedToolOutputs<Item>(
  provider: string,
  outcomes: AgentModelRequest["outcomes"],
  availableBytes: number,
  wrap: (outcome: Outcome, output: string) => Item
): Item[] {
  const texts = outcomes.map((outcome) =>
    JSON.stringify(
      outcome.ok ? { ok: true, value: outcome.value } : { ok: false, error: outcome.error }
    )
  );
  const outputs = outcomes.map((outcome, index) => wrap(outcome, texts[index]!));
  const budget = Math.min(MAX_TOOL_OUTPUT_BYTES, availableBytes);
  if (
    outputs.length === 0 ||
    outputs.reduce((bytes, item) => bytes + encodedBytes(item) + 1, 0) <= budget
  )
    return outputs;
  const entries = outputs.map((item, index) => {
    const outcome = outcomes[index]!;
    const bytes = utf8Bytes(texts[index]!);
    const preview = (length: number) =>
      wrap(
        outcome,
        JSON.stringify({
          ok: outcome.ok,
          truncated: true,
          originalBytes: bytes.length,
          preview: new TextDecoder().decode(bytes.subarray(0, length), { stream: true }),
          notice:
            "Result truncated for model context. Retrieve narrower results; do not repeat successful mutations.",
        })
      );
    const marker = preview(0);
    const minimum = encodedBytes(item) <= encodedBytes(marker) ? item : marker;
    return { item, bytes, preview, minimum, minimumBytes: encodedBytes(minimum) + 1 };
  });
  const remaining = budget - entries.reduce((total, entry) => total + entry.minimumBytes, 0);
  if (remaining < 0) throw new Error(`${provider} request has no room for tool output metadata`);
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
