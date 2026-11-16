import { utf8ByteLength } from "./provider-utf8.js";
import { MAX_RESPONSE_BYTES } from "./provider-limits.js";
import { readProviderEvents } from "./provider-sse.js";
import type { Awaitable } from "./agent-types.js";
import { awaitWithAbort, throwIfAborted } from "../utilities/abort.js";

/** Ephemeral public text from one HTTP attempt; completed text is captured separately. */
export type AgentTextEvent = Readonly<{
  streamId: string;
  provider: "openai" | "anthropic";
  turn: number;
}> &
  (
    | Readonly<{ kind: "delta"; text: string }>
    | Readonly<{ kind: "end"; status: "completed" | "interrupted" }>
  );

/** The destination owns filtering and I/O; its signal includes the provider deadline. */
export type AgentTextSink = (event: AgentTextEvent, signal: AbortSignal) => Awaitable<void>;

export type AgentTextProtocol = (
  events: AsyncIterable<string>,
  write: (text: string) => Promise<void>
) => Promise<Record<string, unknown>>;

export async function readAgentText(
  response: Response,
  protocol: AgentTextProtocol,
  provider: AgentTextEvent["provider"],
  turn: number,
  sink: AgentTextSink,
  signal: AbortSignal
): Promise<Record<string, unknown>> {
  const identity = { streamId: globalThis.crypto.randomUUID(), provider, turn };
  const label = provider === "openai" ? "OpenAI" : "Anthropic";
  let bytes = 0;
  let completed = false;
  const deliver = async (event: AgentTextEvent) => {
    try {
      await awaitWithAbort(
        Promise.resolve(sink(Object.freeze(event), signal)),
        signal,
        "Agent text sink"
      );
    } catch {
      throwIfAborted(signal, "Agent text stream");
      throw new Error("Agent text sink failed");
    }
  };
  try {
    const body = await protocol(readProviderEvents(response, signal, label), async (text) => {
      bytes += utf8ByteLength(text);
      if (bytes > 1_048_576) throw new Error("Agent text stream exceeds 1 MiB");
      for (let start = 0; start < text.length;) {
        let end = Math.min(start + 4096, text.length);
        if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
        throwIfAborted(signal, "Agent text stream");
        await deliver({ ...identity, kind: "delta", text: text.slice(start, end) });
        start = end;
      }
    });
    if (utf8ByteLength(JSON.stringify(body)) > MAX_RESPONSE_BYTES)
      throw new Error(`${label} stream response exceeds 2 MiB`);
    completed = true;
    return body;
  } finally {
    const ending = deliver({
      ...identity,
      kind: "end",
      status: completed ? "completed" : "interrupted",
    });
    if (completed) await ending;
    else await ending.catch(() => {});
  }
}
