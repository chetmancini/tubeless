import { createServer } from "node:http";
import { once } from "node:events";
import { setTimeout } from "node:timers/promises";
import type { AgentModelFactory } from "tubeless/cli";
import { anthropicModel } from "tubeless/agent/anthropic";

/** A local Messages API fixture: real SSE parsing and CLI output, without credentials. */
const createModel: AgentModelFactory =
  ({ text }) =>
  async (request, context) => {
    const server = createServer((_incoming, response) => {
      _incoming.resume();
      response.writeHead(200, { "content-type": "text/event-stream" });
      const send = (event: object) => response.write(`data: ${JSON.stringify(event)}\n\n`);
      void (async () => {
        send({
          type: "message_start",
          message: {
            type: "message",
            role: "assistant",
            content: [],
            usage: { input_tokens: 1, output_tokens: 0 },
          },
        });
        send({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
        for (const word of ["Streaming ", "public ", "assistant ", "text."]) {
          await setTimeout(80, undefined, { signal: context.signal });
          send({
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: word },
          });
        }
        send({ type: "content_block_stop", index: 0 });
        send({
          type: "content_block_start",
          index: 1,
          content_block: { type: "tool_use", id: "finish", name: "_finish", input: {} },
        });
        send({
          type: "content_block_delta",
          index: 1,
          delta: {
            type: "input_json_delta",
            partial_json: JSON.stringify({
              result: { answer: "The validated final answer stays on stdout." },
            }),
          },
        });
        send({ type: "content_block_stop", index: 1 });
        send({
          type: "message_delta",
          delta: { stop_reason: "tool_use" },
          usage: { output_tokens: 10 },
        });
        send({ type: "message_stop" });
        response.end();
      })().catch(() => response.destroy());
    });
    try {
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Fixture server did not start");
      return await anthropicModel({
        model: "fixture",
        apiKey: "local-fixture",
        baseUrl: `http://127.0.0.1:${address.port}`,
        compactAfterBytes: null,
        text,
      })(request, context);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };

export default createModel;
