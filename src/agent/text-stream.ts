import { randomUUID } from "node:crypto";
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

/** Opt-in streaming, independent of transcript persistence. */
export interface AgentTextOptions {
  /** Awaited in order for backpressure, within the provider deadline. Failure fails the request. */
  readonly write: (event: AgentTextEvent) => Awaitable<void>;
  /** Filter each bounded delta before delivery. Use streamId to maintain cross-delta state. */
  readonly redact?: (event: Extract<AgentTextEvent, { kind: "delta" }>) => Awaitable<string | null>;
}

export function textSettings(options: AgentTextOptions | undefined): AgentTextOptions | undefined {
  if (options === undefined) return undefined;
  if (
    !options ||
    typeof options.write !== "function" ||
    (options.redact !== undefined && typeof options.redact !== "function")
  )
    throw new Error("Invalid agent text configuration");
  return Object.freeze({ write: options.write, redact: options.redact });
}

/** One bounded attempt. No raw provider data or error text crosses this port. */
export class AgentTextStream {
  private readonly identity;
  private bytes = 0;
  private ended = false;
  private deliveredBytes = 0;

  constructor(
    provider: "openai" | "anthropic",
    turn: number,
    private readonly options: AgentTextOptions,
    private readonly signal: AbortSignal
  ) {
    this.identity = Object.freeze({ streamId: randomUUID(), provider, turn });
  }

  async delta(text: string): Promise<void> {
    if (this.ended) throw new Error("Agent text stream already ended");
    this.bytes += Buffer.byteLength(text);
    if (this.bytes > 1_048_576) throw new Error("Agent text stream exceeds 1 MiB");
    // At most 16 KiB of UTF-8, without cutting a surrogate pair.
    for (let start = 0; start < text.length;) {
      let end = Math.min(start + 4096, text.length);
      if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
      const event = Object.freeze({
        ...this.identity,
        kind: "delta" as const,
        text: text.slice(start, end),
      });
      start = end;
      throwIfAborted(this.signal, "Agent text stream");
      try {
        const filtered = this.options.redact
          ? await awaitWithAbort(
              Promise.resolve(this.options.redact(event)),
              this.signal,
              "Agent text redaction"
            )
          : event.text;
        if (filtered === null) continue;
        if (typeof filtered !== "string" || Buffer.byteLength(filtered) > 16_384)
          throw new Error("Invalid redacted text");
        this.deliveredBytes += Buffer.byteLength(filtered);
        if (this.deliveredBytes > 1_048_576) throw new Error("Redacted text exceeds 1 MiB");
        if (filtered)
          await awaitWithAbort(
            Promise.resolve(this.options.write(Object.freeze({ ...event, text: filtered }))),
            this.signal,
            "Agent text sink"
          );
      } catch {
        throwIfAborted(this.signal, "Agent text stream");
        throw new Error("Agent text sink failed");
      }
    }
  }

  async end(status: "completed" | "interrupted"): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    try {
      await awaitWithAbort(
        Promise.resolve(
          this.options.write(Object.freeze({ ...this.identity, kind: "end", status }))
        ),
        this.signal,
        "Agent text sink"
      );
    } catch {
      if (status === "completed") {
        throwIfAborted(this.signal, "Agent text stream");
        throw new Error("Agent text sink failed");
      }
      // An interruption notification is best effort; never hide the original failure.
    }
  }
}
