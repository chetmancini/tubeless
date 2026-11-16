import { describe, expect, it } from "vitest";
import { parseProviderEvent, readProviderEvents } from "./provider-sse.js";

const response = (value: string | Uint8Array) =>
  new Response(typeof value === "string" ? value : new Uint8Array(value), {
    headers: { "content-type": "text/event-stream" },
  });
async function collect(response: Response, signal = new AbortController().signal) {
  const events: string[] = [];
  for await (const event of readProviderEvents(response, signal, "Fixture")) events.push(event);
  return events;
}

describe("provider SSE boundaries", () => {
  it("accepts comments, unknown fields, BOM and multiline data", async () => {
    expect(
      await collect(
        response('\uFEFF: keepalive\nevent: ignored\nid: 1\ndata: {"type":\ndata: "done"}\n\n')
      )
    ).toEqual(['{"type":\n"done"}']);
  });

  it("leaves payload interpretation and EOF completion to the protocol consumer", async () => {
    expect(
      await collect(response('data: {"type":"ping"}\n\ndata: [DONE]\n\ndata: unfinished'))
    ).toEqual(['{"type":"ping"}', "[DONE]"]);
  });

  it.each([
    { body: new Uint8Array([0xff]), error: "invalid UTF-8" },
    { body: "data: " + "x".repeat(2_101_248), error: "event exceeds" },
  ])("rejects invalid framing: $error", async ({ body, error }) => {
    await expect(collect(response(body))).rejects.toThrow(error);
  });

  it.each(["secret-not-json", "[]", "null"])(
    "rejects invalid JSON events without exposing their content: %s",
    (data) => {
      expect(() => parseProviderEvent(data, "Fixture")).toThrow(
        /Fixture stream contains (invalid JSON|an invalid event)/
      );
    }
  );

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
      collect(new Response(body, { headers: { "content-type": "text/event-stream" } }))
    ).rejects.toThrow(/exceeds/);
    expect(cancelled).toBe(true);
  });

  it("cancels the reader when its consumer returns before EOF", async () => {
    let cancelled = false;
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: first\n\ndata: second\n\n"));
      },
      cancel() {
        cancelled = true;
      },
    });
    for await (const event of readProviderEvents(
      new Response(body, { headers: { "content-type": "text/event-stream" } }),
      new AbortController().signal,
      "Fixture"
    )) {
      expect(event).toBe("first");
      break;
    }
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
    const reading = collect(
      new Response(body, { headers: { "content-type": "text/event-stream" } }),
      controller.signal
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
      collect(new Response(body, { headers: { "content-type": "text/event-stream" } }))
    ).rejects.toThrow("Fixture stream interrupted");
  });
});
