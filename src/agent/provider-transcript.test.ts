import { afterEach, describe, expect, it, vi } from "vitest";
import { defineAgent, type AgentTranscriptRecord } from "./agent.js";
import { openaiModel } from "./openai.js";
import { anthropicModel } from "./anthropic.js";
import { defer } from "../core/child-pipeline.test-support.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function providerFetcher(provider: "openai" | "anthropic") {
  return vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
    const payload = JSON.parse(init!.body as string);
    if (String(url).endsWith("/compact"))
      return Response.json({
        object: "response.compaction",
        output: [{ type: "compaction", encrypted_content: "encrypted-secret" }],
      });
    if (payload.compaction)
      return Response.json({
        type: "message",
        role: "assistant",
        stop_reason: "compaction",
        content: [
          { type: "compaction", content: "native-summary-secret", signature: "signature-secret" },
        ],
      });
    if (provider === "openai")
      return Response.json({
        status: "completed",
        output: [
          {
            type: "reasoning",
            encrypted_content: "encrypted-secret",
            summary: [{ type: "summary_text", text: "reasoning-secret" }],
          },
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Visible text" }],
          },
          {
            type: "function_call",
            call_id: "finish",
            name: "_finish",
            arguments: JSON.stringify({ result: { answer: "done" } }),
          },
        ],
      });
    return Response.json({
      type: "message",
      role: "assistant",
      stop_reason: "tool_use",
      content: [
        { type: "thinking", thinking: "thinking-secret", signature: "signature-secret" },
        { type: "text", text: "Visible text" },
        {
          type: "tool_use",
          id: "finish",
          name: "_finish",
          input: { result: { answer: "done" } },
        },
      ],
    });
  });
}

describe.each(["openai", "anthropic"] as const)("%s transcript", (provider) => {
  it("drains transcript writes outside the provider deadline", async () => {
    const deadline = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    const release = defer();
    let writing = false;
    let providerDone = false;
    vi.stubGlobal("fetch", providerFetcher(provider));
    const transport = (provider === "openai" ? openaiModel : anthropicModel)({
      apiKey: "fixture",
      compactAfterBytes: 1,
      timeoutMs: 50,
    });
    const agent = defineAgent({
      id: "slow-transcript",
      projectContext: false,
      defaultTools: [],
      transcript: {
        write: async (record) => {
          if ("event" in record && record.event.kind === "compaction") {
            writing = true;
            await release.promise;
            writing = false;
          }
        },
      },
      model: async (request, context) => {
        const response = await transport(
          { ...request, conversation: [{ role: "user", content: "prior" }] },
          context
        );
        providerDone = true;
        return response;
      },
    });
    const run = agent.run({ task: "continue" });
    try {
      await vi.waitFor(() => expect(providerDone).toBe(true));
      expect(writing).toBe(true);
      deadline.abort(new Error("Provider deadline elapsed while saving"));
    } finally {
      release.resolve();
      await run;
    }
    expect((await run).status).toBe("completed");
  });

  it("captures public text and successful compaction without provider state or reasoning", async () => {
    const records: AgentTranscriptRecord[] = [];
    const fetcher = providerFetcher(provider);
    vi.stubGlobal("fetch", fetcher);
    const transport = (provider === "openai" ? openaiModel : anthropicModel)({
      apiKey: "api-key-secret",
      compactAfterBytes: 1,
    });
    const agent = defineAgent({
      id: "provider-capture",
      projectContext: false,
      defaultTools: [],
      transcript: {
        redact: async (event) => event,
        write: (record) => {
          records.push(record);
        },
      },
      model: (request, context) =>
        transport(
          { ...request, conversation: [{ role: "user", content: "provider-private-history" }] },
          context
        ),
    });
    expect(await agent.runOrThrow({ task: "A public task" })).toEqual({ answer: "done" });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(records.flatMap((record) => ("event" in record ? [record.event] : []))).toEqual([
      { kind: "prompt", task: "A public task", instructions: expect.any(String) },
      { kind: "compaction", provider },
      { kind: "assistant", text: "Visible text" },
      { kind: "decision", decision: { kind: "finish", result: { answer: "done" } } },
      { kind: "end", status: "completed" },
    ]);
    const encoded = JSON.stringify(records);
    for (const secret of [
      "encrypted-secret",
      "reasoning-secret",
      "thinking-secret",
      "signature-secret",
      "native-summary-secret",
      "api-key-secret",
      "provider-private-history",
    ])
      expect(encoded).not.toContain(secret);
  });
});

it.each([
  { provider: "openai", failure: "invalid arguments" },
  { provider: "openai", failure: "incomplete" },
  { provider: "anthropic", failure: "max_tokens" },
  { provider: "anthropic", failure: "refusal" },
] as const)(
  "retains public text from a failed $provider response: $failure",
  async ({ provider, failure }) => {
    const records: AgentTranscriptRecord[] = [];
    const visible = "Visible text before failure";
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockImplementation(async () =>
        Response.json(
          provider === "openai"
            ? {
                status: failure === "incomplete" ? "incomplete" : "completed",
                output: [
                  { type: "reasoning", encrypted_content: "private-reasoning" },
                  { type: "message", content: [{ type: "output_text", text: visible }] },
                  {
                    type: "function_call",
                    call_id: "broken",
                    name: "_finish",
                    arguments: "invalid JSON",
                  },
                ],
              }
            : {
                type: "message",
                stop_reason: failure,
                content: [
                  { type: "thinking", thinking: "private-reasoning" },
                  { type: "text", text: visible },
                ],
              }
        )
      )
    );
    const model = (provider === "openai" ? openaiModel : anthropicModel)({ apiKey: "fixture" });
    const result = await defineAgent({
      id: "failed-response",
      projectContext: false,
      defaultTools: [],
      model,
      transcript: {
        write: (record) => {
          records.push(record);
        },
      },
    }).run({ task: "Finish" });
    expect(result.status).toBe("failed");
    const captured = records.flatMap((record) => ("event" in record ? [record.event] : []));
    expect(captured.filter((event) => event.kind === "assistant")).toEqual([
      { kind: "assistant", text: visible },
    ]);
    expect(captured.at(-1)).toEqual({ kind: "end", status: "failed" });
    expect(JSON.stringify(records)).not.toContain("private-reasoning");
  }
);

it("does not record an Anthropic compaction attempt that returns no signed summary", async () => {
  const records: AgentTranscriptRecord[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      const payload = JSON.parse(init!.body as string);
      return Response.json({
        type: "message",
        role: "assistant",
        stop_reason: payload.compaction ? "compaction" : "tool_use",
        content: payload.compaction
          ? [{ type: "text", text: "No signed summary" }]
          : [
              {
                type: "tool_use",
                id: "finish",
                name: "_finish",
                input: { result: { answer: "done" } },
              },
            ],
      });
    })
  );
  const transport = anthropicModel({ apiKey: "fixture", compactAfterBytes: 1 });
  await defineAgent({
    id: "no-summary",
    projectContext: false,
    defaultTools: [],
    transcript: {
      write: (record) => {
        records.push(record);
      },
    },
    model: (request, context) =>
      transport({ ...request, conversation: [{ role: "user", content: "prior" }] }, context),
  }).runOrThrow({ task: "continue" });
  expect(records.some((record) => "event" in record && record.event.kind === "compaction")).toBe(
    false
  );
});
