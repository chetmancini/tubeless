import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RemoteStepsPipeline } from "../../examples/remote-steps.js";
import { handleHostJob, HostedPipeline } from "../../examples/host-embedding.js";

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          server.closeAllConnections();
        })
    )
  );
});

async function listen(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP address");
  return `http://127.0.0.1:${address.port}`;
}

const options = (endpoint: string) => ({ endpoint, lines: [" Alpha ", "", "Beta"] });

describe("HTTP remote recipe", () => {
  it.each([false, true])("crosses HTTP with dryRun=%s and run correlation", async (dryRun) => {
    const requests: unknown[] = [];
    let writes = 0;
    const endpoint = await listen((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => {
        body += chunk;
      });
      request.on("end", () => {
        const payload = JSON.parse(body);
        requests.push({ method: request.method, path: request.url, payload });
        // The service, not just the client, gates its side effect.
        if (!payload.dryRun) writes++;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ orderId: "order-1", rows: payload.rows }));
      });
    });
    const result = await RemoteStepsPipeline.runOrThrow(
      options(endpoint),
      { dryRun },
      { runId: "caller-1" }
    );
    expect(result).toEqual({ orderId: "order-1", count: 2 });
    expect(requests).toEqual([
      {
        method: "POST",
        path: "/enrich",
        payload: {
          dryRun,
          rows: ["Alpha", "Beta"],
          runId: "caller-1",
        },
      },
    ]);
    expect(writes).toBe(dryRun ? 0 : 1);
  });

  it.each([null, { orderId: 1, rows: [] }, { orderId: "1", rows: [42] }])(
    "rejects invalid output %j before downstream work",
    async (body) => {
      const endpoint = await listen((_request, response) => response.end(JSON.stringify(body)));
      const result = await RemoteStepsPipeline.run(options(endpoint));
      expect(result.status).toBe("failed");
      expect(result.errors[0]).toMatchObject({ kind: "validation", stepId: "enrich" });
      expect(result.steps.find((entry) => entry.id === "summarize")?.status).toBe("skipped");
    }
  );

  it("preserves HTTP status as a machine code and cause even with an HTML error", async () => {
    const endpoint = await listen((_request, response) => {
      response.writeHead(503);
      response.end("<html>unavailable</html>");
    });
    const result = await RemoteStepsPipeline.run(options(endpoint));
    expect(result.errors[0]).toMatchObject({
      code: "TUBELESS_STEP_FAILED",
      sourceCode: "HTTP_503",
      cause: { message: "HTTP 503 Service Unavailable" },
      stepId: "enrich",
    });
    expect(result.steps.find((entry) => entry.id === "summarize")?.status).toBe("skipped");
  });

  it("surfaces a dropped connection as a remote step failure", async () => {
    const endpoint = await listen((request) => request.socket.destroy());
    const result = await RemoteStepsPipeline.run(options(endpoint));
    expect(result.status).toBe("failed");
    expect(result.errors[0]).toMatchObject({ code: "TUBELESS_STEP_FAILED", stepId: "enrich" });
  });

  it("surfaces malformed JSON as a failure", async () => {
    const endpoint = await listen((_request, response) => response.end("not json"));
    const result = await RemoteStepsPipeline.run(options(endpoint));
    expect(result.errors[0]).toMatchObject({ code: "TUBELESS_STEP_FAILED", stepId: "enrich" });
  });

  it("aborts an in-flight HTTP response and prevents downstream execution", async () => {
    const controller = new AbortController();
    let disconnected!: () => void;
    const closed = new Promise<void>((resolve) => {
      disconnected = resolve;
    });
    const endpoint = await listen((_request, response) => {
      response.on("close", disconnected);
      // Abort only once a real request has reached the service.
      controller.abort();
    });
    const result = await RemoteStepsPipeline.run(options(endpoint), undefined, {
      signal: controller.signal,
    });
    expect(result.status).toBe("cancelled");
    expect(result.errors[0]).toMatchObject({ code: "TUBELESS_RUN_CANCELLED", stepId: "enrich" });
    expect(result.steps.find((entry) => entry.id === "summarize")?.status).not.toBe("completed");
    await closed;
  });
});

describe("host embedding recipe", () => {
  const job = { runId: "attempt-1", parentRunId: "workflow-1", dryRun: true, lines: [" Alpha "] };
  it("passes host IDs and dry-run into the embedded pipeline", async () => {
    const run = vi.spyOn(HostedPipeline, "runOrThrow");
    try {
      expect(await handleHostJob(job)).toEqual({ rows: ["Alpha"], preview: true });
      expect(run).toHaveBeenCalledWith(
        { lines: job.lines },
        { dryRun: true },
        {
          runId: "attempt-1",
          parentRunId: "workflow-1",
          signal: undefined,
        }
      );
    } finally {
      run.mockRestore();
    }
  });
  it("rejects cancellation so the host can withhold acknowledgement", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(handleHostJob(job, controller.signal)).rejects.toThrow();
  });
});
