import { afterEach, describe, expect, it, vi } from "vitest";
import { createHostedCollectorClient } from "./client.js";
import { createCollectorTransport } from "./transport.js";
import { collectorFixture, started, completed, log } from "./fixture.test-support.js";

const cleanup: (() => void)[] = [];
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0)) close();
});
async function setup() {
  const fixture = await collectorFixture();
  cleanup.push(() => fixture.store.close());
  return fixture;
}
const json = (value: unknown) => Response.json(value);

describe("collector delivery client", () => {
  it("bounds typed failure reports in bytes for both direct and stateful callers", async () => {
    const { client, token } = await setup();
    const fetch = vi.fn<typeof globalThis.fetch>();
    const transport = createCollectorTransport({
      baseUrl: "https://collector.test",
      launchId: "launch",
      workerId: "worker",
      token,
      fetch,
    });
    const message = "💥".repeat(2049);
    await expect(transport.reportFailure({ attemptId: "attempt", message })).rejects.toMatchObject({
      status: 413,
    });
    expect(fetch).not.toHaveBeenCalled();
    const worker = client();
    await worker.claim();
    await expect(worker.reportFailure(message)).rejects.toMatchObject({ status: 413 });
    expect(await worker.append([started(), completed()])).toEqual({
      accepted: true,
      runId: "root",
    });
  });
  it("delivers through the Fetch handler, retries exact committed bytes, and preserves queued snapshots", async () => {
    const { collector, client, events } = await setup();
    const deliveries: Uint8Array[] = [];
    let lostReply = false;
    const transport = vi.fn<typeof fetch>(async (input, init) => {
      expect(init).toMatchObject({
        redirect: "error",
        credentials: "omit",
        cache: "no-store",
        referrerPolicy: "no-referrer",
      });
      if (String(input).endsWith("/batches"))
        deliveries.push(new Uint8Array(init!.body as Uint8Array));
      const response = await collector.fetch(new Request(input, init));
      if (String(input).endsWith("/batches") && !lostReply) {
        lostReply = true;
        throw new TypeError("lost reply with secret");
      }
      return response;
    });
    const worker = client(transport);
    expect(await worker.claim()).toBe(true);
    const mutable = log("original");
    const first = worker.append([started()]);
    const second = worker.append([mutable, completed()]);
    mutable.payload.message = "changed";
    expect(await first).toEqual({ accepted: true, runId: "root" });
    expect(await second).toEqual({ accepted: true, runId: "root" });
    expect(deliveries).toHaveLength(3);
    expect(deliveries[0]).toEqual(deliveries[1]);
    expect(JSON.parse(new TextDecoder().decode(deliveries[2])).sequence).toBe(1);
    expect((await events.listEvents()).map((event) => event.name)).toEqual([
      "pipeline.started",
      "pipeline.log",
      "pipeline.completed",
    ]);
    expect((await events.listEvents())[1]).toMatchObject({ payload: { message: "original" } });
  });

  it.each(["lost", "unavailable", "invalid", "oversized", "html"])(
    "never retries an uncertain %s claim or allows execution",
    async (mode) => {
      const { client, collector, readLaunch } = await setup();
      const transport = vi.fn<typeof fetch>(async (input, init) => {
        if (mode === "lost") {
          await collector.fetch(new Request(input, init));
          throw new TypeError("secret");
        }
        if (mode === "unavailable") return new Response(null, { status: 503 });
        if (mode === "oversized")
          return new Response(" ".repeat(8193), {
            headers: { "content-type": "application/json" },
          });
        if (mode === "html") return new Response('{"admitted":true}');
        return json({ admitted: true, injected: "secret" });
      });
      const worker = client(transport);
      await expect(worker.claim()).rejects.toThrow();
      expect(await worker.claim()).toBe(false);
      await expect(worker.append([started()])).rejects.toThrow();
      expect(transport).toHaveBeenCalledOnce();
      expect(readLaunch("launch")?.admitted).toBe(mode === "lost" ? 1 : 0);
      expect(await client().claim()).toBe(mode !== "lost");
    }
  );

  it("splits by count and encoded bytes while maintaining one contiguous sequence", async () => {
    const { client, collector, events } = await setup();
    const bodies: { sequence: number; events: unknown[] }[] = [];
    const worker = client(async (input, init) => {
      if (String(input).endsWith("/batches")) {
        const bytes = init!.body as Uint8Array;
        expect(bytes.byteLength).toBeLessThanOrEqual(1_048_576);
        bodies.push(JSON.parse(new TextDecoder().decode(bytes)));
      }
      return collector.fetch(new Request(input, init));
    });
    await worker.claim();
    await worker.append([started(), ...Array.from({ length: 54 }, () => log())]);
    await worker.append([log("é".repeat(300_000)), log("é".repeat(300_000)), completed()]);
    expect(bodies.map((b) => [b.sequence, b.events.length])).toEqual([
      [0, 50],
      [1, 5],
      [2, 1],
      [3, 2],
    ]);
    expect(await events.listEvents()).toHaveLength(58);
  });

  it("rejects an oversized event before sending any part of the append", async () => {
    const { client, collector, events } = await setup();
    const transport = vi.fn<typeof fetch>((input, init) =>
      collector.fetch(new Request(input, init))
    );
    const worker = client(transport);
    await worker.claim();
    await expect(worker.append([started(), log("x".repeat(1_048_576))])).rejects.toMatchObject({
      status: 413,
    });
    expect(transport).toHaveBeenCalledOnce();
    expect(await events.listEvents()).toEqual([]);
  });

  it.each([401, 409, 413])(
    "does not retry permanent %i delivery failures or reuse an uncertain sequence",
    async (status) => {
      const { client } = await setup();
      const transport = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(json({ admitted: true }))
        .mockResolvedValue(new Response(null, { status }));
      const worker = client(transport);
      await worker.claim();
      await expect(worker.append([started()])).rejects.toMatchObject({ status });
      await expect(worker.append([log()])).rejects.toMatchObject({ status });
      expect(transport).toHaveBeenCalledTimes(2);
    }
  );

  it("reports an exited execution once after queued writes, retries its exact failure receipt, and stops new writes", async () => {
    const { client, collector, events } = await setup();
    const bodies: string[] = [];
    let lost = false;
    const worker = client(async (input, init) => {
      if (String(input).endsWith("/failure"))
        bodies.push(new TextDecoder().decode(init!.body as Uint8Array));
      const response = await collector.fetch(new Request(input, init));
      if (String(input).endsWith("/failure") && !lost) {
        lost = true;
        throw new TypeError("lost");
      }
      return response;
    });
    await worker.claim();
    const appended = worker.append([started()]);
    const logged = worker.append([log()]);
    const failed = worker.reportFailure("Worker exited");
    await expect(worker.append([log()])).rejects.toThrow();
    await appended;
    await logged;
    expect(await failed).toBe(true);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toBe(bodies[1]);
    expect(await events.listEvents()).toHaveLength(3);
    expect((await events.listEvents()).at(-1)).toMatchObject({
      name: "pipeline.completed",
      payload: { status: "failed" },
    });
  });

  it("cancels delivery backoff without dispatching another request", async () => {
    vi.useFakeTimers();
    const abort = new AbortController();
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ admitted: true }))
      .mockResolvedValue(new Response(null, { status: 503 }));
    const worker = createHostedCollectorClient({
      baseUrl: "https://collector.test",
      launchId: "launch",
      attemptId: "attempt",
      deploymentId: "release",
      token: `${"a".repeat(32)}.${"b".repeat(64)}`,
      fetch: transport,
      signal: abort.signal,
    });
    await worker.claim();
    const pending = worker.append([started()]);
    const checked = expect(pending).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(50);
    abort.abort();
    await checked;
    await vi.advanceTimersByTimeAsync(1000);
    expect(transport).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("times out an uncooperative claim transport, observes late rejection, and never retries", async () => {
    vi.useFakeTimers();
    let reject!: (cause: Error) => void;
    const { client } = await setup();
    const transport = vi.fn<typeof fetch>(
      () =>
        new Promise<Response>((_, fail) => {
          reject = fail;
        })
    );
    const worker = client(transport);
    const pending = worker.claim();
    const checked = expect(pending).rejects.toMatchObject({ status: 0 });
    await vi.advanceTimersByTimeAsync(10_000);
    await checked;
    reject(new Error("late failure secret"));
    await Promise.resolve();
    expect(await worker.claim()).toBe(false);
    expect(transport).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels a stalled response without awaiting its uncooperative cancellation", async () => {
    vi.useFakeTimers();
    const { client } = await setup();
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const worker = client(
      async () =>
        new Response(new ReadableStream<Uint8Array>({ cancel }), {
          headers: { "content-type": "application/json" },
        })
    );
    const pending = worker.claim();
    const checked = expect(pending).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(10_000);
    await checked;
    expect(cancel).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects insecure and credential-bearing base URLs before contacting a transport", async () => {
    const { token } = await setup();
    const transport = vi.fn<typeof fetch>();
    for (const baseUrl of [
      "http://collector.test",
      "https://user:pass@collector.test",
      "https://collector.test/?token=secret",
      "https://collector.test/#fragment",
    ])
      expect(() =>
        createHostedCollectorClient({
          baseUrl,
          launchId: "launch",
          attemptId: "attempt",
          deploymentId: "release",
          token,
          fetch: transport,
        })
      ).toThrow();
    expect(transport).not.toHaveBeenCalled();
  });

  it("exhausts four delivery attempts without declaring execution terminated", async () => {
    vi.useFakeTimers();
    const { client } = await setup();
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ admitted: true }))
      .mockResolvedValue(new Response(null, { status: 503 }));
    const worker = client(transport);
    await worker.claim();
    const checked = expect(worker.append([started()])).rejects.toMatchObject({ status: 503 });
    await vi.advanceTimersByTimeAsync(700);
    await checked;
    expect(transport).toHaveBeenCalledTimes(5);
    expect(transport.mock.calls.every(([url]) => !String(url).endsWith("/failure"))).toBe(true);
    await expect(worker.append([log()])).rejects.toMatchObject({ status: 503 });
    expect(transport).toHaveBeenCalledTimes(5);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    { accepted: true },
    { accepted: false },
    { accepted: true, runId: "root", unexpected: true },
  ])(
    "rejects malformed batch acknowledgement %j without retrying or reusing its sequence",
    async (ack) => {
      const { client } = await setup();
      const transport = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(json({ admitted: true }))
        .mockImplementation(async () => json(ack));
      const worker = client(transport);
      await worker.claim();
      await expect(worker.append([started()])).rejects.toThrow();
      await expect(worker.append([log()])).rejects.toThrow();
      expect(transport).toHaveBeenCalledTimes(2);
    }
  );

  it("closes delivery on HTTP 410 and refuses writes queued behind the closed batch", async () => {
    const { client } = await setup();
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ admitted: true }))
      .mockResolvedValue(new Response(null, { status: 410 }));
    const worker = client(transport);
    await worker.claim();
    const first = worker.append([started()]);
    const second = worker.append([log()]);
    const refused = expect(second).rejects.toThrow();
    expect(await first).toEqual({ accepted: false });
    await refused;
    await expect(worker.append([log()])).rejects.toThrow();
    expect(transport).toHaveBeenCalledTimes(2);
  });
});
