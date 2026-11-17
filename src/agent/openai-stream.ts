import { record } from "./provider-schema.js";
import { parseProviderEvent } from "./provider-sse.js";
import { outputItems } from "./openai-protocol.js";
import type { AgentTextProtocol } from "./text-stream.js";

/** Retain only the final native response; reconcile public deltas against its text. */
export const readOpenAIStream: AgentTextProtocol = async (events, write) => {
  const assistants = new Set<number>();
  const parts = new Map<string, string>();
  for await (const data of events) {
    if (data === "[DONE]") break;
    const event = parseProviderEvent(data, "OpenAI");
    if (
      event.type === "error" ||
      event.type === "response.failed" ||
      event.type === "response.incomplete"
    )
      throw new Error("OpenAI stream failed");
    const index = event.output_index;
    if (
      event.type === "response.output_item.added" &&
      Number.isSafeInteger(index) &&
      record(event.item)
    ) {
      if (event.item.type === "message" && event.item.role === "assistant")
        assistants.add(index as number);
    }
    const key = `${String(index)}:${String(event.content_index)}`;
    if (
      event.type === "response.content_part.added" &&
      assistants.has(index as number) &&
      Number.isSafeInteger(event.content_index) &&
      record(event.part) &&
      event.part.type === "output_text"
    ) {
      if (parts.has(key) || typeof event.part.text !== "string")
        throw new Error("OpenAI stream invalid text block");
      parts.set(key, event.part.text);
      await write(event.part.text);
    }
    if (event.type === "response.output_text.delta" && parts.has(key)) {
      if (typeof event.delta !== "string") throw new Error("OpenAI stream invalid text delta");
      parts.set(key, parts.get(key)! + event.delta);
      await write(event.delta);
    }
    if (event.type !== "response.completed") continue;
    const body = event.response;
    if (!record(body) || body.status !== "completed")
      throw new Error("OpenAI stream invalid final response");
    const reconciled = new Set<string>();
    const output = outputItems(body);
    for (const [outputIndex, item] of output.entries()) {
      if (item.type !== "message" || item.role !== "assistant" || !Array.isArray(item.content))
        continue;
      for (const [contentIndex, part] of item.content.entries()) {
        if (!record(part) || part.type !== "output_text" || typeof part.text !== "string") continue;
        const partKey = `${outputIndex}:${contentIndex}`;
        if (parts.has(partKey)) {
          if (parts.get(partKey) !== part.text)
            throw new Error("OpenAI stream text does not match final response");
          reconciled.add(partKey);
        } else await write(part.text);
      }
    }
    if (reconciled.size !== parts.size) throw new Error("OpenAI stream missing final text block");
    return body;
  }
  throw new Error("OpenAI stream interrupted before completion");
};
