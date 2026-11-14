import { afterEach, describe, expect, it, vi } from "vitest";
import { defineAgent, type AgentTranscriptRecord } from "./agent.js";
import { openaiModel } from "./openai.js";
import { anthropicModel } from "./anthropic.js";

afterEach(() => vi.unstubAllGlobals());

describe.each(["openai", "anthropic"] as const)("%s transcript", (provider) => {
  it("captures public text and successful compaction without provider state or reasoning", async () => {
    const records: AgentTranscriptRecord[] = [];
    const requests: unknown[] = [];
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
      const payload = JSON.parse(init!.body as string);
      requests.push(payload);
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
    expect(requests).toHaveLength(2);
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
