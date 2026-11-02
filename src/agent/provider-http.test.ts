import { createServer, type RequestListener } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { httpTransport } from "./mcp-http.js";
import { providerRequest } from "./provider-http.js";

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
