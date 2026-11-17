import { afterEach, describe, expect, it, vi } from "vitest";
import {
  defineAgent,
  createAgentSession,
  type AgentTextEvent,
  type AgentTranscriptRecord,
} from "./agent.js";
import { openaiModel } from "./openai.js";
import { anthropicModel } from "./anthropic.js";
import { readAgentText } from "./text-stream.js";

afterEach(() => vi.unstubAllGlobals());
const finish = {
  type: "function_call",
  call_id: "finish",
  name: "_finish",
  arguments: '{"result":{"answer":"Done"}}',
};
const publicMessage = (text = "Hello 🌍") => ({
  type: "message",
  role: "assistant",
  content: [{ type: "output_text", text }],
});
function openaiEvents(text = "Hello 🌍", finalText = text) {
  return [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "reasoning", encrypted_content: "private reasoning" },
    },
    { type: "response.reasoning_text.delta", delta: "private thinking" },
    {
      type: "response.output_item.added",
      output_index: 1,
      item: { type: "message", role: "assistant" },
    },
    {
      type: "response.content_part.added",
      output_index: 1,
      content_index: 0,
      part: { type: "output_text", text: "" },
    },
    { type: "response.output_text.delta", output_index: 1, content_index: 0, delta: text },
    { type: "response.function_call_arguments.delta", delta: "private arguments" },
    {
      type: "response.completed",
      response: {
        status: "completed",
        output: [
          { type: "reasoning", encrypted_content: "private reasoning" },
          publicMessage(finalText),
          finish,
        ],
        usage: { input_tokens: 1, output_tokens: 2 },
      },
    },
  ];
}
function anthropicEvents(text = "Hello 🌍") {
  return [
    {
      type: "message_start",
      message: {
        type: "message",
        role: "assistant",
        content: [],
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    },
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "thinking", thinking: "", signature: "" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking: "private thinking" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "signature_delta", signature: "private signature" },
    },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 1, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 1 },
    {
      type: "content_block_start",
      index: 2,
      content_block: { type: "tool_use", id: "finish", name: "_finish", input: {} },
    },
    {
      type: "content_block_delta",
      index: 2,
      delta: { type: "input_json_delta", partial_json: '{"result":{"answer":' },
    },
    {
      type: "content_block_delta",
      index: 2,
      delta: { type: "input_json_delta", partial_json: '"Done"}}' },
    },
    { type: "content_block_stop", index: 2 },
    {
      type: "message_delta",
      delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: { output_tokens: 2 },
    },
    { type: "message_stop" },
  ];
}
const encoded = (events: unknown[], newline = "\n") =>
  new TextEncoder().encode(
    events.map((event) => `data: ${JSON.stringify(event)}${newline}${newline}`).join("")
  );
function stream(events: unknown[], split = 17, newline = "\n") {
  const bytes = encoded(events, newline);
  let offset = 0;
  return new Response(
    new ReadableStream({
      pull(controller) {
        if (offset === bytes.length) return controller.close();
        controller.enqueue(bytes.slice(offset, (offset += split)));
        offset = Math.min(offset, bytes.length);
      },
    }),
    { headers: { "content-type": "text/event-stream" } }
  );
}
const protocols = [
  { name: "openai" as const, model: openaiModel, events: openaiEvents },
  { name: "anthropic" as const, model: anthropicModel, events: anthropicEvents },
];
const agent = (model: ReturnType<typeof openaiModel>, transcript?: AgentTranscriptRecord[]) =>
  defineAgent({
    id: "stream",
    model,
    projectContext: false,
    defaultTools: [],
    ...(transcript
      ? {
          transcript: {
            write: (event) => {
              transcript.push(event);
            },
          },
        }
      : {}),
  });

describe.each(protocols)("$name public text streaming", ({ name, model, events }) => {
  it.each(["\n", "\r\n", "\r"])(
    "reconciles fragmented UTF-8 and %j framing into one captured message",
    async (newline) => {
      const observed: AgentTextEvent[] = [];
      const records: AgentTranscriptRecord[] = [];
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(stream(events(), 1, newline));
      vi.stubGlobal("fetch", fetcher);
      const session = createAgentSession(
        agent(
          model({
            apiKey: "fixture",
            text(event) {
              observed.push(event);
            },
          }),
          records
        )
      );
      const run = await session.run({ task: "hello" });
      expect(run.status).toBe("completed");
      expect(run.value).toEqual({ answer: "Done" });
      expect(
        observed
          .filter((event) => event.kind === "delta")
          .map((event) => event.text)
          .join("")
      ).toBe("Hello 🌍");
      expect(observed.at(-1)).toMatchObject({
        kind: "end",
        status: "completed",
        provider: name,
        turn: 1,
      });
      expect(new Set(observed.map((event) => event.streamId)).size).toBe(1);
      expect(JSON.stringify(observed)).not.toContain("private");
      expect(JSON.stringify(session.conversation)).toContain(
        name === "openai" ? "private reasoning" : "private signature"
      );
      expect(
        records.flatMap((record) =>
          "event" in record && record.event.kind === "assistant" ? [record.event] : []
        )
      ).toEqual([{ kind: "assistant", text: "Hello 🌍" }]);
      expect(JSON.parse(fetcher.mock.calls[0][1]!.body as string).stream).toBe(true);
    }
  );

  it("delivers text before completion and waits for the sink before consuming more events", async () => {
    const observed: AgentTextEvent[] = [];
    let release!: () => void;
    let sawDelta!: () => void;
    const started = new Promise<void>((resolve) => {
      sawDelta = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(stream(events(), 100_000)));
    let finished = false;
    const running = agent(
      model({
        apiKey: "fixture",
        async text(event) {
          observed.push(event);
          if (event.kind === "delta") {
            sawDelta();
            await blocked;
          }
        },
      })
    )
      .run({ task: "hi" })
      .then((run) => {
        finished = true;
        return run;
      });
    await started;
    expect(finished).toBe(false);
    expect(observed).toHaveLength(1);
    release();
    expect((await running).status).toBe("completed");
    expect(observed.at(-1)).toMatchObject({ kind: "end", status: "completed" });
  });

  it("marks truncated streams interrupted, never retries accepted streams or commits their conversation", async () => {
    const observed: AgentTextEvent[] = [];
    const fetcher = vi.fn().mockResolvedValue(stream(events().slice(0, -1)));
    vi.stubGlobal("fetch", fetcher);
    const session = createAgentSession(
      agent(
        model({
          apiKey: "fixture",
          text(event) {
            observed.push(event);
          },
        })
      )
    );
    const run = await session.run({ task: "hi" });
    expect(run.status).toBe("failed");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(session.conversation).toBeNull();
    expect(observed.at(-1)).toMatchObject({ kind: "end", status: "interrupted" });
  });

  it.each(["caller", "deadline"])(
    "interrupts a blocked sink on %s without leaking its errors",
    async (reason) => {
      const controller = new AbortController();
      const observed: AgentTextEvent[] = [];
      let released = false;
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(stream(events())));
      const run = await agent(
        model({
          apiKey: "fixture",
          timeoutMs: reason === "deadline" ? 30 : 5000,
          text(event, signal) {
            observed.push(event);
            if (event.kind === "end") return;
            const pending = new Promise<void>((resolve) => {
              signal.addEventListener(
                "abort",
                () => {
                  released = true;
                  resolve();
                },
                { once: true }
              );
            });
            if (reason === "caller") controller.abort();
            return pending;
          },
        })
      ).run({ task: "hi" }, undefined, { signal: controller.signal });
      expect(run.status).toBe(reason === "caller" ? "cancelled" : "failed");
      expect(released).toBe(true);
      expect(observed.at(-1)).toMatchObject({ kind: "end", status: "interrupted" });
      if (reason === "deadline") expect(run.errors[0].message).toContain("timed out");
    }
  );

  it("releases filtering I/O on the attempt deadline before delivering any text", async () => {
    let released = false;
    const observed: AgentTextEvent[] = [];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(stream(events())));
    const run = await agent(
      model({
        apiKey: "fixture",
        timeoutMs: 30,
        async text(event, signal) {
          if (event.kind === "end") {
            observed.push(event);
            return;
          }
          await new Promise<void>((resolve) =>
            signal.addEventListener(
              "abort",
              () => {
                released = true;
                resolve();
              },
              { once: true }
            )
          );
        },
      })
    ).run({ task: "hi" });
    expect(run.status).toBe("failed");
    expect(released).toBe(true);
    expect(observed).toEqual([expect.objectContaining({ kind: "end", status: "interrupted" })]);
  });

  it("redacts terminal observations independently of completed transcript capture", async () => {
    const observed: AgentTextEvent[] = [];
    const captured: AgentTranscriptRecord[] = [];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(stream(events("secret"))));
    await defineAgent({
      id: "redacted",
      projectContext: false,
      defaultTools: [],
      model: model({
        apiKey: "fixture",
        text(event) {
          observed.push(event.kind === "delta" ? { ...event, text: "[filtered]" } : event);
        },
      }),
      transcript: {
        redact: (event) =>
          event.kind === "assistant" ? { ...event, text: "[saved filter]" } : event,
        write(record) {
          captured.push(record);
        },
      },
    }).runOrThrow({ task: "hi" });
    expect(JSON.stringify(observed)).not.toContain("secret");
    expect(
      captured.flatMap((record) =>
        "event" in record && record.event.kind === "assistant" ? [record.event] : []
      )
    ).toEqual([{ kind: "assistant", text: "[saved filter]" }]);
  });

  it("retries HTTP failures before accepting a stream without replaying observations", async () => {
    const observed: AgentTextEvent[] = [];
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response("private HTTP error", { status: 429, headers: { "retry-after": "0" } })
      )
      .mockResolvedValueOnce(stream(events()));
    vi.stubGlobal("fetch", fetcher);
    await agent(
      model({
        apiKey: "fixture",
        text(event) {
          observed.push(event);
        },
      })
    ).runOrThrow({ task: "hi" });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(observed.filter((event) => event.kind === "delta")).toHaveLength(1);
    expect(observed.filter((event) => event.kind === "end")).toHaveLength(1);
  });

  it("budgets the streaming field before generating near-limit tool previews", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(stream(events()));
    vi.stubGlobal("fetch", fetcher);
    const transport = model({
      model: "fixture",
      apiKey: "fixture",
      compactAfterBytes: null,
      text() {},
    });
    await agent((request, context) =>
      transport(
        {
          ...request,
          conversation: [{ role: "user", content: "h".repeat(900_000) }],
          outcomes: [{ id: "call", tool: "fixture", ok: true, value: "v".repeat(200_000) }],
        },
        context
      )
    ).runOrThrow({ task: "hi" });
    const body = fetcher.mock.calls[0][1]!.body as string;
    const payload = JSON.parse(body);
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(1_048_576);
    expect(payload.stream).toBe(true);
    const output =
      name === "openai" ? payload.input.at(-1).output : payload.messages.at(-1).content[0].content;
    expect(JSON.parse(output)).toMatchObject({ ok: true, truncated: true });
  });

  it("bounds the completed native response through the shared streaming shim", async () => {
    const native = "x".repeat(2_097_152);
    const oversized =
      name === "openai"
        ? [
            {
              type: "response.completed",
              response: { status: "completed", output: [finish], native },
            },
          ]
        : [
            {
              type: "message_start",
              message: { type: "message", role: "assistant", content: [], native },
            },
            { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: {} },
            { type: "message_stop" },
          ];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(stream(oversized, 100_000)));
    const observed: AgentTextEvent[] = [];
    const run = await agent(
      model({
        apiKey: "fixture",
        text(event) {
          observed.push(event);
        },
      })
    ).run({ task: "hi" });
    expect(run.status).toBe("failed");
    expect(run.errors[0].message).toContain("response exceeds 2 MiB");
    expect(observed).toEqual([expect.objectContaining({ kind: "end", status: "interrupted" })]);
  });

  it("keeps compaction on JSON and out of public observations", async () => {
    const observed: AgentTextEvent[] = [];
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json(
          name === "openai"
            ? {
                object: "response.compaction",
                output: [{ type: "compaction", encrypted_content: "private summary" }],
              }
            : {
                type: "message",
                stop_reason: "compaction",
                content: [
                  {
                    type: "compaction",
                    content: "private summary",
                    signature: "private signature",
                  },
                ],
              }
        )
      )
      .mockResolvedValueOnce(stream(events()));
    vi.stubGlobal("fetch", fetcher);
    const transport = model({
      apiKey: "fixture",
      compactAfterBytes: 1,
      text(event) {
        observed.push(event);
      },
    });
    await agent((request, context) =>
      transport({ ...request, conversation: [{ role: "user", content: "old prompt" }] }, context)
    ).runOrThrow({ task: "hi" });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetcher.mock.calls[0][1]!.body as string)).not.toHaveProperty("stream");
    expect(JSON.parse(fetcher.mock.calls[1][1]!.body as string).stream).toBe(true);
    expect(JSON.stringify(observed)).not.toContain("private");
  });

  it("sanitizes protocol errors and sink failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(stream([{ type: "error", error: { message: "secret credential" } }]))
    );
    const run = await agent(model({ apiKey: "fixture", text() {} })).run({ task: "hi" });
    expect(run.status).toBe("failed");
    expect(JSON.stringify(run.errors)).not.toContain("secret credential");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(stream(events())));
    const failedSink = await agent(
      model({
        apiKey: "fixture",
        text() {
          throw new Error("secret credential");
        },
      })
    ).run({ task: "hi" });
    expect(failedSink.status).toBe("failed");
    expect(failedSink.errors[0].message).toContain("Agent text sink failed");
    expect(JSON.stringify(failedSink.errors)).not.toContain("secret credential");
  });
});

it("rejects OpenAI final-text mismatch without committing a conversation", async () => {
  const observed: AgentTextEvent[] = [];
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(stream(openaiEvents("partial", "different"))));
  const run = await agent(
    openaiModel({
      apiKey: "fixture",
      text(event) {
        observed.push(event);
      },
    })
  ).run({ task: "hi" });
  expect(run.status).toBe("failed");
  expect(run.errors[0].message).toContain("text does not match final response");
  expect(observed.at(-1)).toMatchObject({ status: "interrupted" });
});

it("bounds text and splits Unicode without cutting code points", async () => {
  const observed: AgentTextEvent[] = [];
  const signal = new AbortController().signal;
  const running = readAgentText(
    new Response(null),
    async (_events, write) => {
      await write("a".repeat(4095) + "🌍".repeat(3000));
      await write("x".repeat(1_048_576));
      return {};
    },
    "openai",
    1,
    (event) => {
      observed.push(event);
    },
    signal
  );
  await expect(running).rejects.toThrow("exceeds");
  const chunks = observed.filter((event) => event.kind === "delta").map((event) => event.text);
  expect(chunks.join("")).toBe("a".repeat(4095) + "🌍".repeat(3000));
  expect(
    chunks.every(
      (chunk) => Buffer.from(chunk).toString("utf8") === chunk && Buffer.byteLength(chunk) <= 16_384
    )
  ).toBe(true);
  expect(observed.at(-1)).toMatchObject({ kind: "end", status: "interrupted" });
});
