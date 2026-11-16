import { Miniflare, NoOpLog } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { manifestModules } from "../cloudflare/cloudflare-workerd.test-support.js";
import type { AgentModelResponse } from "./model-types.js";
import type { AgentTextEvent } from "./text-stream.js";

// Exercise the emitted provider graph directly, without bundler shims. Adapted from
// Cloud's runtime-compatibility.integration.mjs and tubeless@0.4.0 portability patch.
const WORKER = String.raw`
import { openaiModel } from "./agent/openai.js";
import { anthropicModel } from "./agent/anthropic.js";

const resultSchema = {
  type: "object", properties: { answer: { type: "string" } },
  required: ["answer"], additionalProperties: false,
};
function fragmented(text, contentType, cancel) {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new Response(new ReadableStream({
    pull(controller) {
      if (offset === bytes.length) return controller.close();
      controller.enqueue(bytes.slice(offset, ++offset));
    },
    cancel,
  }), { headers: { "content-type": contentType } });
}
function streamEvents(openai) {
  const answer = { answer: "Done 🌍" };
  return openai ? [
    { type: "response.output_item.added", output_index: 0, item: { type: "message", role: "assistant" } },
    { type: "response.content_part.added", output_index: 0, content_index: 0, part: { type: "output_text", text: "" } },
    { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "Hello 🌍" },
    { type: "response.completed", response: { status: "completed", output: [
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "Hello 🌍" }] },
      { type: "function_call", call_id: "finish", name: "_finish", arguments: JSON.stringify({ result: answer }) },
    ] } },
  ] : [
    { type: "message_start", message: { type: "message", role: "assistant", content: [], usage: { input_tokens: 1, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello 🌍" } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "finish", name: "_finish", input: {} } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: JSON.stringify({ result: answer }) } },
    { type: "content_block_stop", index: 1 },
    { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 2 } },
    { type: "message_stop" },
  ];
}
export default {
  async fetch(request) {
    const { provider, stream, scenario = "success" } = await request.json();
    const openai = provider === "openai";
    const observed = [], requests = [], logs = [];
    const controller = new AbortController();
    let cancelled = false;
    let output;
    globalThis.fetch = async (_url, init) => {
      requests.push(new TextEncoder().encode(init.body).byteLength);
      if (requests.length === 1)
        return new Response(null, { status: 503, headers: { "retry-after": "0" } });
      if (scenario === "response-limit") return new Response(" ".repeat(2097153));
      const payload = JSON.parse(init.body);
      const items = openai ? payload.input : payload.messages.flatMap(message => message.content ?? []);
      const item = items.find(item => item.type === (openai ? "function_call_output" : "tool_result"));
      output = JSON.parse(openai ? item.output : item.content);
      const events = streamEvents(openai);
      return stream
        ? fragmented("\uFEFF" + events.map(event => "data: " + JSON.stringify(event) + "\n\n").join(""), "text/event-stream", () => { cancelled = true; })
        : fragmented(JSON.stringify(openai ? events.at(-1).response : {
            type: "message", role: "assistant", stop_reason: "tool_use",
            content: [{ type: "tool_use", id: "finish", name: "_finish", input: { result: { answer: "Done 🌍" } } }],
          }), "application/json");
    };
    const model = (openai ? openaiModel : anthropicModel)({
      ...(scenario === "missing-credentials" ? {} : { apiKey: "fixture" }),
      maxRetries: 1, compactAfterBytes: null,
      ...(stream ? { text: event => {
        observed.push(event);
        if (scenario === "sink-abort" && event.kind === "delta")
          controller.abort(new Error("stop streaming"));
      } } : {}),
    });
    const globals = { Buffer: typeof Buffer, process: typeof process };
    try {
      const response = await model({
        instructions: scenario === "request-limit" ? "🌍".repeat(300000) : "Finish the task.",
        task: "Say hello", conversation: [],
        outcomes: scenario === "request-limit" ? [] : [{ id: "large", tool: "large", ok: true, value: "🌍".repeat(100000) }],
      }, {
        turn: 2, capabilities: [], resultJsonSchema: resultSchema,
        signal: controller.signal, reportAttempt() {},
        log: { log() {}, warn: message => logs.push(message) },
      });
      return Response.json({ globals, response, observed, requests, logs, output, cancelled });
    } catch (error) {
      return Response.json({ globals, error: error.message, observed, requests, logs, cancelled });
    }
  },
};
`;

let mf: Miniflare;
beforeAll(async () => {
  mf = new Miniflare({
    log: new NoOpLog(),
    telemetry: { enabled: false },
    workers: [
      {
        config: {
          name: "provider-portability",
          compatibilityDate: "2026-11-15",
          // Explicitly disable both: recent compatibility dates enable Node by default.
          compatibilityFlags: ["no_nodejs_compat", "no_nodejs_compat_v2"],
          manifest: { mainModule: "worker.js", modules: manifestModules(WORKER) },
        },
      },
    ],
  });
  await mf.ready;
}, 60_000);
afterAll(() => mf?.dispose());

interface WorkerResult {
  globals: Record<string, string>;
  response: AgentModelResponse;
  observed: AgentTextEvent[];
  requests: number[];
  logs: string[];
  output: { preview: string };
  cancelled: boolean;
  error?: string;
}

async function run(provider: string, stream: boolean, scenario = "success") {
  const response = await mf.dispatchFetch("http://providers.test", {
    method: "POST",
    body: JSON.stringify({ provider, stream, scenario }),
  });
  return (await response.json()) as WorkerResult;
}

describe.each(["openai", "anthropic"])("%s without Node compatibility", (provider) => {
  it.each([false, true])(
    "retries fragmented UTF-8 responses and bounds tool outputs (stream: %s)",
    async (stream) => {
      const result = await run(provider, stream);
      expect(result.globals).toEqual({ Buffer: "undefined", process: "undefined" });
      expect(result.error).toBeUndefined();
      expect(result.response.decision).toEqual({ kind: "finish", result: { answer: "Done 🌍" } });
      expect(result.requests).toHaveLength(2);
      expect(result.requests[0]).toBe(result.requests[1]);
      expect(result.requests[0]).toBeLessThanOrEqual(1_048_576);
      expect(result.logs).toHaveLength(1);
      expect(result.output).toMatchObject({ ok: true, truncated: true, originalBytes: 400022 });
      expect(result.output.preview).not.toContain("\uFFFD");
      if (stream) {
        expect(
          result.observed.flatMap((event) => (event.kind === "delta" ? [event.text] : [])).join("")
        ).toBe("Hello 🌍");
        expect(result.observed.at(-1)).toMatchObject({
          kind: "end",
          status: "completed",
          provider,
        });
        expect(result.observed[0]!.streamId).toMatch(/^[0-9a-f-]{36}$/);
        expect(new Set(result.observed.map((event) => event.streamId)).size).toBe(1);
      } else expect(result.observed).toEqual([]);
    }
  );

  it("rejects oversized UTF-8 requests before fetching", async () => {
    const result = await run(provider, false, "request-limit");
    expect(result.error).toContain("request exceeds 1 MiB");
    expect(result.requests).toEqual([]);
  });

  it("rejects oversized responses after a transient retry", async () => {
    const result = await run(provider, false, "response-limit");
    expect(result.error).toContain("response exceeds 2097152 bytes");
    expect(result.requests).toHaveLength(2);
  });

  it("reports missing credentials without accessing a Node global", async () => {
    const result = await run(provider, false, "missing-credentials");
    expect(result.error).toContain("is required for live model execution");
    expect(result.requests).toEqual([]);
  });

  it("cancels streaming reads when the text sink aborts", async () => {
    const result = await run(provider, true, "sink-abort");
    expect(result.error).toContain("stop streaming");
    expect(result.cancelled).toBe(true);
    expect(result.observed.at(-1)).toMatchObject({ kind: "end", status: "interrupted" });
    expect(result.requests).toHaveLength(2);
  });
});
