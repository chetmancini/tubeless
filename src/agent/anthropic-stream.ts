import { record } from "./provider-schema.js";
import { parseProviderEvent } from "./provider-sse.js";
import type { AgentTextProtocol } from "./text-stream.js";

/** Assemble native tool/thinking blocks privately; only text blocks reach the text port. */
export const readAnthropicStream: AgentTextProtocol = async (events, write) => {
  let message: Record<string, unknown> | undefined;
  const blocks: Record<string, unknown>[] = [];
  const open = new Set<number>();
  const inputs = new Map<number, string>();
  for await (const data of events) {
    const event = parseProviderEvent(data, "Anthropic");
    if (event.type === "error") throw new Error("Anthropic stream failed");
    if (event.type === "message_start") {
      if (
        message ||
        !record(event.message) ||
        event.message.role !== "assistant" ||
        !Array.isArray(event.message.content) ||
        event.message.content.length
      )
        throw new Error("Anthropic stream invalid message start");
      message = { ...event.message };
    } else if (event.type === "content_block_start") {
      if (!message || event.index !== blocks.length || !record(event.content_block))
        throw new Error("Anthropic stream invalid block start");
      const block = { ...event.content_block };
      blocks.push(block);
      open.add(event.index);
      if (block.type === "text" && typeof block.text === "string") await write(block.text);
    } else if (event.type === "content_block_delta") {
      const index = event.index as number;
      const block = blocks[index];
      const delta = event.delta;
      if (!open.has(index) || !block || !record(delta))
        throw new Error("Anthropic stream invalid block delta");
      if (delta.type === "text_delta" && block.type === "text" && typeof delta.text === "string") {
        block.text = String(block.text ?? "") + delta.text;
        await write(delta.text);
      } else if (
        delta.type === "input_json_delta" &&
        block.type === "tool_use" &&
        typeof delta.partial_json === "string"
      ) {
        inputs.set(index, (inputs.get(index) ?? "") + delta.partial_json);
      } else if (
        delta.type === "thinking_delta" &&
        block.type === "thinking" &&
        typeof delta.thinking === "string"
      ) {
        block.thinking = String(block.thinking ?? "") + delta.thinking;
      } else if (
        delta.type === "signature_delta" &&
        block.type === "thinking" &&
        typeof delta.signature === "string"
      ) {
        block.signature = String(block.signature ?? "") + delta.signature;
      } else if (
        delta.type === "citations_delta" &&
        block.type === "text" &&
        record(delta.citation)
      ) {
        block.citations = [
          ...(Array.isArray(block.citations) ? block.citations : []),
          delta.citation,
        ];
      } else throw new Error("Anthropic stream unsupported block delta");
    } else if (event.type === "content_block_stop") {
      const index = event.index as number;
      if (!open.delete(index)) throw new Error("Anthropic stream invalid block stop");
      if (inputs.has(index)) {
        try {
          blocks[index].input = JSON.parse(inputs.get(index)!);
        } catch {
          throw new Error("Anthropic stream invalid tool JSON");
        }
        inputs.delete(index);
      }
    } else if (event.type === "message_delta") {
      if (!message || !record(event.delta) || !record(event.usage))
        throw new Error("Anthropic stream invalid message delta");
      message = {
        ...message,
        ...event.delta,
        usage: { ...(record(message.usage) ? message.usage : {}), ...event.usage },
      };
    } else if (event.type === "message_stop") {
      if (!message || open.size || typeof message.stop_reason !== "string")
        throw new Error("Anthropic stream incomplete message");
      message.content = blocks;
      return message;
    }
  }
  throw new Error("Anthropic stream interrupted before completion");
};
