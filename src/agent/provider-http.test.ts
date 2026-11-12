import { createServer, type RequestListener } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { httpTransport } from "./mcp-http.js";
import { ProviderRequestError, providerRequest, withProviderRetry } from "./provider-http.js";

async function server(handler: RequestListener) {
  const instance = createServer(handler);
  await new Promise<void>((resolve) => instance.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(instance.address() as AddressInfo).port}`,
    async close() {
      instance.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        instance.close((error) => (error ? reject(error) : resolve()))
      );
    },
  };
}

const signal = () => AbortSignal.timeout(2000);
const credentials = { "X-Fixture-Key": "synthetic-credential" };

describe("credential-bearing HTTP requests", () => {
  it("keeps credentials and JSON on a directly configured provider endpoint", async () => {
    const received: unknown[] = [];
    const endpoint = await server(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      received.push([request.method, request.headers["x-fixture-key"], JSON.parse(body)]);
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end('{"ok":true}');
    });
    try {
      await expect(
        providerRequest(
          "Fixture",
          "decision",
          endpoint.url,
          credentials,
          { task: "hello" },
          signal()
        )
      ).resolves.toEqual({ ok: true });
      expect(received).toEqual([["POST", "synthetic-credential", { task: "hello" }]]);
    } finally {
      await endpoint.close();
    }
  });

  it.each([301, 302, 303, 307, 308])(
    "does not follow provider HTTP %s redirects to another origin or a relative path",
    async (status) => {
      let forwarded = 0;
      const destination = await server((_request, response) => {
        forwarded++;
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end("{}");
      });
      const endpoint = await server((request, response) => {
        if (request.url === "/relative-target") {
          forwarded++;
          response.writeHead(200, { "Content-Type": "application/json" });
          response.end("{}");
          return;
        }
        expect(request.headers["x-fixture-key"]).toBe("synthetic-credential");
        response.writeHead(status, {
          Location: request.url === "/relative" ? "/relative-target" : destination.url,
        });
        response.end("private redirect diagnostics");
      });
      try {
        for (const path of ["/cross-origin", "/relative"]) {
          await expect(
            providerRequest("Fixture", "decision", endpoint.url + path, credentials, {}, signal())
          ).rejects.toThrow(`Fixture decision failed (HTTP ${status})`);
        }
        expect(forwarded).toBe(0);
      } finally {
        await endpoint.close();
        await destination.close();
      }
    }
  );

  it.each(["initialize", "request", "close"] as const)(
    "does not follow MCP redirects during %s",
    async (phase) => {
      let forwarded = 0;
      let deletes = 0;
      const received: [string | undefined, string | undefined, string | undefined][] = [];
      const destination = await server((_request, response) => {
        forwarded++;
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end('{"jsonrpc":"2.0","id":2,"result":{}}');
      });
      const endpoint = await server(async (request, response) => {
        received.push([
          request.method,
          request.headers["mcp-session-id"] as string | undefined,
          request.headers["mcp-protocol-version"] as string | undefined,
        ]);
        expect(request.headers["x-fixture-key"]).toBe("synthetic-credential");
        let body = "";
        for await (const chunk of request) body += chunk;
        const message = body ? JSON.parse(body) : undefined;
        if (request.method === "DELETE") deletes++;
        if (
          phase === "initialize" ||
          (phase === "request" && message?.method !== "initialize") ||
          (phase === "close" && request.method === "DELETE")
        ) {
          response.writeHead(307, { Location: destination.url });
          response.end();
          return;
        }
        response.writeHead(200, {
          "Content-Type": "application/json",
          "Mcp-Session-Id": "fixture-session",
        });
        response.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: { protocolVersion: "2025-06-18" },
          })
        );
      });
      const transport = httpTransport(
        "fixture",
        { url: endpoint.url, headers: credentials },
        {
          receive: () => {},
        }
      );
      try {
        const initialize = transport.send(
          { jsonrpc: "2.0", id: 1, method: "initialize" },
          signal()
        );
        if (phase === "initialize") await expect(initialize).rejects.toThrow("HTTP 307");
        else {
          await initialize;
          if (phase === "request")
            await expect(
              transport.send({ jsonrpc: "2.0", id: 2, method: "tools/list" }, signal())
            ).rejects.toThrow("HTTP 307");
          else {
            await transport.send({ jsonrpc: "2.0", id: 2, method: "tools/list" }, signal());
            await Promise.all([transport.close(), transport.close()]);
            expect(deletes).toBe(1);
          }
          expect(received[1]).toEqual(["POST", "fixture-session", "2025-06-18"]);
        }
        expect(forwarded).toBe(0);
      } finally {
        await transport.close();
        await endpoint.close();
        await destination.close();
      }
    }
  );
});

type RetryOptions = Parameters<typeof withProviderRetry>[0];

const request = (signal: AbortSignal) =>
  providerRequest(
    "Fixture",
    "decision",
    "https://provider.test/v1/fixture",
    credentials,
    {},
    signal
  );

async function failure(signal: AbortSignal): Promise<ProviderRequestError> {
  try {
    await request(signal);
  } catch (error) {
    if (error instanceof ProviderRequestError) return error;
    throw error;
  }
  throw new Error("expected the request to fail");
}

const stub = (status: number, headers: Record<string, string> = {}) =>
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status, headers }))
  );

const transient = (status?: number, retryAfterMs?: number) =>
  new ProviderRequestError(
    status === undefined
      ? "Fixture decision failed (network error)"
      : `Fixture decision failed (HTTP ${status})`,
    { status, retryable: true, retryAfterMs }
  );

const retry = <T>(attempt: () => Promise<T>, overrides: Partial<RetryOptions> = {}) =>
  withProviderRetry(
    {
      maxRetries: 2,
      signal: new AbortController().signal,
      remainingMs: () => 60_000,
      label: "Fixture decision",
      random: () => 0,
      sleep: async () => {},
      ...overrides,
    },
    attempt
  );

describe("provider HTTP failure classification", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reports a retryable rate limit with its Retry-After delay", async () => {
    stub(429, { "retry-after": "2" });
    const error = await failure(AbortSignal.timeout(2000));
    expect(error.message).toBe("Fixture decision failed (HTTP 429)");
    expect(error.status).toBe(429);
    expect(error.retryable).toBe(true);
    expect(error.retryAfterMs).toBe(2000);
  });

  it("prefers retry-after-ms and ignores unusable Retry-After values", async () => {
    stub(429, { "retry-after-ms": "150", "retry-after": "2" });
    expect((await failure(AbortSignal.timeout(2000))).retryAfterMs).toBe(150);

    stub(429, { "retry-after": new Date(Date.now() + 5000).toUTCString() });
    const dated = (await failure(AbortSignal.timeout(2000))).retryAfterMs;
    expect(dated).toBeGreaterThan(0);
    expect(dated).toBeLessThanOrEqual(5000);

    stub(429, { "retry-after": "later" });
    expect((await failure(AbortSignal.timeout(2000))).retryAfterMs).toBeUndefined();
  });

  it.each([400, 401, 403, 404, 307])("never retries HTTP %i", async (status) => {
    stub(status);
    const error = await failure(AbortSignal.timeout(2000));
    expect(error.status).toBe(status);
    expect(error.retryable).toBe(false);
  });

  it.each([408, 429, 500, 503, 529])("retries HTTP %i", async (status) => {
    stub(status);
    const error = await failure(AbortSignal.timeout(2000));
    expect(error.status).toBe(status);
    expect(error.retryable).toBe(true);
  });

  it("classifies a dropped connection as a retryable network failure", async () => {
    const dropped = new TypeError("fetch failed");
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockRejectedValue(dropped));
    const error = await failure(AbortSignal.timeout(2000));
    expect(error.message).toBe("Fixture decision failed (network error)");
    expect(error.status).toBeUndefined();
    expect(error.retryable).toBe(true);
    expect(error.cause).toBe(dropped);
  });

  it("returns the original rejection when the caller aborts the exchange", async () => {
    const controller = new AbortController();
    const aborted = new Error("stop");
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockImplementation(() => {
        controller.abort(aborted);
        return Promise.reject(aborted);
      })
    );
    await expect(request(controller.signal)).rejects.toBe(aborted);
  });
});

describe("provider retry policy", () => {
  it("doubles the backoff and succeeds on the third attempt", async () => {
    const sleeps: number[] = [];
    const attempts = vi
      .fn()
      .mockRejectedValueOnce(transient(429))
      .mockRejectedValueOnce(transient(429))
      .mockResolvedValue("done");
    await expect(
      retry(() => attempts(), { sleep: async (ms) => void sleeps.push(ms) })
    ).resolves.toBe("done");
    expect(attempts).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([500, 1000]);
  });

  it("waits the server's Retry-After instead of the backoff schedule", async () => {
    const sleeps: number[] = [];
    const attempts = vi.fn().mockRejectedValueOnce(transient(429, 1200)).mockResolvedValue("done");
    await expect(
      retry(() => attempts(), { sleep: async (ms) => void sleeps.push(ms) })
    ).resolves.toBe("done");
    expect(attempts).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([1200]);
  });

  it("makes one attempt when retries are disabled", async () => {
    const attempts = vi.fn().mockRejectedValue(transient(503));
    await expect(retry(() => attempts(), { maxRetries: 0 })).rejects.toBeInstanceOf(
      ProviderRequestError
    );
    expect(attempts).toHaveBeenCalledTimes(1);
  });

  it("does not retry a non-retryable status or a plain error", async () => {
    const rejected = vi.fn().mockRejectedValue(
      new ProviderRequestError("Fixture decision failed (HTTP 400)", {
        status: 400,
        retryable: false,
      })
    );
    await expect(retry(() => rejected())).rejects.toBeInstanceOf(ProviderRequestError);
    expect(rejected).toHaveBeenCalledTimes(1);

    const plain = vi.fn().mockRejectedValue(new Error("Fixture decision failed"));
    await expect(retry(() => plain())).rejects.toThrow("Fixture decision failed");
    expect(plain).toHaveBeenCalledTimes(1);
  });

  it("fails instead of waiting past a minute or past the deadline", async () => {
    const longWait = vi.fn().mockRejectedValue(transient(429, 120_000));
    const sleeps: number[] = [];
    await expect(
      retry(() => longWait(), { sleep: async (ms) => void sleeps.push(ms) })
    ).rejects.toBeInstanceOf(ProviderRequestError);
    expect(longWait).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);

    const noTime = vi.fn().mockRejectedValue(transient(429));
    const none: number[] = [];
    await expect(
      retry(() => noTime(), {
        remainingMs: () => 100,
        sleep: async (ms) => void none.push(ms),
      })
    ).rejects.toBeInstanceOf(ProviderRequestError);
    expect(noTime).toHaveBeenCalledTimes(1);
    expect(none).toEqual([]);
  });

  it("rethrows the last failure once retries are exhausted", async () => {
    const last = transient(503);
    const attempts = vi.fn().mockRejectedValueOnce(transient(500)).mockRejectedValue(last);
    await expect(retry(() => attempts())).rejects.toBe(last);
    expect(attempts).toHaveBeenCalledTimes(3);
  });

  it("logs the status and the retry count but never the failure message", async () => {
    const messages: string[] = [];
    const attempts = vi
      .fn()
      .mockRejectedValueOnce(
        new ProviderRequestError("Fixture decision failed (HTTP 429): PRIVATE", {
          status: 429,
          retryable: true,
        })
      )
      .mockResolvedValue("done");
    await retry(() => attempts(), { log: (message) => messages.push(message) });
    expect(messages).toEqual([
      "Fixture decision failed (HTTP 429); retrying in 500 ms (retry 1 of 2)",
    ]);
  });
});
