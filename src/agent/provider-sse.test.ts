import { describe, expect, it } from "vitest";
import { readProviderEvents } from "./provider-sse.js";

const response = (value: string | Uint8Array) =>
  new Response(typeof value === "string" ? value : new Uint8Array(value), {
    headers: { "content-type": "text/event-stream" },
  });
const signal = () => new AbortController().signal;

describe("provider SSE boundaries", () => {
  it("accepts comments, unknown fields, BOM and multiline data", async () => {
    const events: unknown[] = [];
    await readProviderEvents(
      response('\uFEFF: keepalive\nevent: ignored\nid: 1\ndata: {"type":\ndata: "done"}\n\n'),
      signal(),
      "Fixture",
      async (event) => {
        events.push(event);
        return true;
      }
    );
    expect(events).toEqual([{ type: "done" }]);
  });

  it.each([
    { body: 'data: {"type":"ping"}\n\n', error: "before completion" },
    { body: "data: [DONE]\n\n", error: "before completion" },
    { body: 'data: {"type":"done"}', error: "before completion" },
    { body: "data: secret-not-json\n\n", error: "invalid JSON" },
    { body: new Uint8Array([0xff]), error: "invalid UTF-8" },
    { body: "data: " + "x".repeat(2_101_248), error: "event exceeds" },
  ])("rejects incomplete or invalid framing: $error", async ({ body, error }) => {
    await expect(
      readProviderEvents(response(body), signal(), "Fixture", async () => {})
    ).rejects.toThrow(error);
  });

  it("limits total bytes even when keepalives contain no JSON", async () => {
    const block = new TextEncoder().encode(": " + "x".repeat(100_000) + "\n\n");
    let cancelled = false;
    const body = new ReadableStream({
      pull(controller) {
        controller.enqueue(block);
      },
      cancel() {
        cancelled = true;
      },
    });
    await expect(
      readProviderEvents(
        new Response(body, { headers: { "content-type": "text/event-stream" } }),
        signal(),
        "Fixture",
        async () => {}
      )
    ).rejects.toThrow(/exceeds/);
    expect(cancelled).toBe(true);
  });

  it("aborts a hanging read and cancels its body without waiting for network cleanup", async () => {
    const controller = new AbortController();
    let cancelled = false;
    const body = new ReadableStream({
      cancel() {
        cancelled = true;
        return new Promise<void>(() => {});
      },
    });
    const reading = readProviderEvents(
      new Response(body, { headers: { "content-type": "text/event-stream" } }),
      controller.signal,
      "Fixture",
      async () => {}
    );
    controller.abort();
    await expect(reading).rejects.toThrow();
    expect(cancelled).toBe(true);
  });

  it("does not expose network error text even when it impersonates an internal error", async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.error(new Error("Fixture stream credential-secret"));
      },
    });
    await expect(
      readProviderEvents(
        new Response(body, { headers: { "content-type": "text/event-stream" } }),
        signal(),
        "Fixture",
        async () => {}
      )
    ).rejects.toThrow("Fixture stream interrupted");
  });
});
