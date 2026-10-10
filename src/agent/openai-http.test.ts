import { afterEach, describe, expect, it, vi } from "vitest";
import { openaiRequest } from "./openai-http.js";

afterEach(() => vi.unstubAllGlobals());

describe("OpenAI HTTP diagnostics", () => {
  it("bounds HTTP payloads and excludes error bodies from diagnostics", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("PRIVATE RESPONSE", { status: 429 }));
    vi.stubGlobal("fetch", fetcher);
    const signal = new AbortController().signal;
    await expect(
      openaiRequest("responses", { input: "x".repeat(1_048_576) }, "fixture", signal)
    ).rejects.toThrow("request exceeds");
    expect(fetcher).not.toHaveBeenCalled();
    await expect(openaiRequest("responses", {}, "fixture", signal)).rejects.toThrow(
      "OpenAI responses failed (HTTP 429)"
    );
    fetcher.mockResolvedValueOnce(new Response("x".repeat(2_097_153)));
    await expect(openaiRequest("responses", {}, "fixture", signal)).rejects.toThrow(
      "response exceeds"
    );
    fetcher.mockResolvedValueOnce(new Response("invalid json"));
    await expect(openaiRequest("responses", {}, "fixture", signal)).rejects.toThrow("invalid JSON");
  });

  it.each([
    { code: "invalid_api_key", advice: "API key was rejected" },
    { code: "ip_not_authorized", advice: "IP is not on" },
    { code: "unknown-private-value", advice: "Authentication was rejected" },
  ])("reports a known reason or safe fallback for $code", async ({ code, advice }) => {
    const response = Response.json(
      {
        error: {
          code,
          message: "Incorrect API key: private-key",
          type: "private-type",
          param: "private-param",
        },
      },
      { status: 401, headers: { "x-request-id": "req_test_123" } }
    );
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
    vi.stubGlobal("fetch", fetcher);
    const error = await openaiRequest(
      "responses",
      {},
      "private-key",
      new AbortController().signal
    ).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain("HTTP 401");
    expect(String(error)).toContain(advice);
    expect(String(error)).toContain("Request ID: req_test_123");
    for (const secret of ["private-key", "private-type", "private-param", "unknown-private-value"])
      expect(String(error)).not.toContain(secret);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(response.body?.locked).toBe(false);
  });

  it.each([
    "<html>private-key</html>",
    "null",
    '{"error":["private-key"]}',
    '{"error":{"code":{"secret":"private-key"}}}',
    "{",
    null,
  ])("keeps HTTP 401 and generic guidance when the body is unusable: %j", async (body) => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(new Response(body, { status: 401 }))
    );
    const error = await openaiRequest(
      "responses/compact",
      {},
      "private-key",
      new AbortController().signal
    ).catch((error: unknown) => error);
    expect(String(error)).toContain("responses/compact failed (HTTP 401)");
    expect(String(error)).toContain("Authentication was rejected");
    expect(String(error)).not.toContain("private-key");
  });

  it("bounds error-body reads and cancels the remaining stream", async () => {
    const cancel = vi.fn();
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(16_385));
        },
        cancel,
      }),
      { status: 401 }
    );
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(response));
    await expect(
      openaiRequest("responses", {}, "fixture", new AbortController().signal)
    ).rejects.toThrow("Authentication was rejected");
    expect(cancel).toHaveBeenCalledOnce();
    expect(response.body?.locked).toBe(false);
  });

  it("does not replace cancellation with an authentication failure", async () => {
    const controller = new AbortController();
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull(stream) {
          controller.abort("stop reading");
          stream.enqueue(new TextEncoder().encode('{"error":{"code":"invalid_api_key"}}'));
        },
      }),
      { status: 401 }
    );
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(response));
    await expect(openaiRequest("responses", {}, "fixture", controller.signal)).rejects.toThrow(
      "aborted: stop reading"
    );
    expect(response.body?.locked).toBe(false);
  });

  it.each(["req_private-key", "sk-private-key", "req_unsafe value"])(
    "omits an unsafe or secret-bearing request ID: %s",
    async (requestId) => {
      vi.stubGlobal(
        "fetch",
        vi
          .fn<typeof fetch>()
          .mockResolvedValue(
            new Response(null, { status: 401, headers: { "x-request-id": requestId } })
          )
      );
      const error = await openaiRequest(
        "responses",
        {},
        "private-key",
        new AbortController().signal
      ).catch((error: unknown) => error);
      expect(String(error)).not.toContain("Request ID");
      expect(String(error)).not.toContain("private-key");
    }
  );
});
