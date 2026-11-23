import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureIo } from "../workbench.test-support.js";
import { createCloudClient } from "./client.js";
import { runCloud } from "./command.js";
import { service } from "./command.test-support.js";
import { FOLLOW_MEDIA_TYPE, type FollowEvent } from "./follow-protocol.js";

const workspace = "fixture-workspace";
const runId = "worker-live";
const raw = readFileSync(
  new URL("../../../fixtures/cloud-run-follow/v1/worker-live.ndjson", import.meta.url),
  "utf8"
);
const [snapshot, , log] = raw.trimEnd().split("\n");
const heartbeat = JSON.stringify({ ...JSON.parse(snapshot), type: "heartbeat", payload: {} });
const origin = "https://cloud.example";
const token = "fixture-secret";
const response = (body: BodyInit) =>
  new Response(body, { headers: { "content-type": FOLLOW_MEDIA_TYPE } });

afterEach(() => vi.useRealTimers());

describe("Cloud follow response bounds", () => {
  it("decodes UTF-8 and NDJSON records split across byte chunks", async () => {
    const bytes = new TextEncoder().encode(raw);
    let offset = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset === bytes.length) controller.close();
        else controller.enqueue(bytes.subarray(offset, ++offset));
      },
    });
    const client = createCloudClient({ host: origin, token, fetch: async () => response(stream) });
    const consume = vi.fn(async (_event: FollowEvent) => {});
    await expect(client.followRun(workspace, runId, undefined, consume)).resolves.toMatchObject({
      type: "terminal",
      payload: { outcome: "completed" },
    });
    expect(consume.mock.calls.map(([event]) => event)).toContainEqual(
      expect.objectContaining({ payload: expect.objectContaining({ message: "Checking café" }) })
    );
  });

  it.each([
    ["foreign workspace", snapshot.replace(workspace, "other") + "\n"],
    ["foreign run", snapshot.replace(runId, "other") + "\n"],
    ["foreign projection", snapshot.replace(`"id":"${runId}"`, '"id":"other"') + "\n"],
    ["token in cursor", snapshot.replace("opaque-live-0", token) + "\n"],
    ["missing snapshot", log + "\n"],
    ["repeated snapshot", [snapshot, snapshot, ""].join("\n")],
    ["oversized event", "x".repeat(32 * 1024)],
    ["oversized stream", "x".repeat(256 * 1024 + 1)],
    ["too many events", [snapshot, ...Array(128).fill(heartbeat), ""].join("\n")],
  ])("rejects %s without treating it as a reconnect boundary", async (_name, body) => {
    const client = createCloudClient({ host: origin, token, fetch: async () => response(body) });
    await expect(
      client.followRun(workspace, runId, undefined, async () => {})
    ).rejects.toMatchObject({
      code: "invalid_response",
    });
  });

  it("does not send a credential pasted as a cursor or a path segment", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const client = createCloudClient({ host: origin, token, fetch: fetcher });
    for (const [id, cursor] of [
      [runId, token],
      [token, undefined],
      ["..", undefined],
    ] as const)
      await expect(client.followRun(workspace, id, cursor, async () => {})).rejects.toMatchObject({
        code: "invalid_request",
      });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("Cloud observation recovery", () => {
  function follower() {
    const dependencies = service();
    const session = dependencies.fetch;
    const request = vi.fn<typeof fetch>();
    const io = captureIo("/detached");
    const args = ["follow", runId, "--host", origin, "--workspace", workspace, "--json"];
    const follow = () =>
      runCloud(args, io, {
        ...dependencies,
        fetch: async (url, init) => {
          if (!String(url).endsWith("/api/v1/session")) return request(url, init);
          const res = await session(url, init);
          return Response.json({
            ...(await res.json()),
            runFollowing: { version: 1, transport: "ndjson" },
          });
        },
      });
    return { follow, io, request };
  }

  it("keeps the acknowledged cursor through bounded failures and redacts echoed authority", async () => {
    const { follow, io, request } = follower();
    request
      .mockResolvedValueOnce(response([snapshot, log, '{"partial":'].join("\n")))
      .mockRejectedValue(new Error(`Unexpected transport diagnostic ${token}`));
    expect(await follow()).toBe(2);
    expect(io.output).toEqual([]);
    const stderr = io.errors.join("");
    expect(stderr).not.toContain(token);
    expect(JSON.parse(stderr)).toMatchObject({
      error: { code: "transport_error" },
      recovery: { host: origin, workspaceId: workspace, runId, cursor: "opaque-live-1" },
    });
    expect(request.mock.calls.map(([url]) => new URL(String(url)).search)).toEqual([
      "",
      "?cursor=opaque-live-1",
      "?cursor=opaque-live-1",
    ]);
  });

  it("classifies a stalled stream separately and cancels its readers", async () => {
    vi.useFakeTimers();
    const { follow, io, request } = follower();
    const cancel = vi.fn();
    request.mockImplementation(async () => response(new ReadableStream<Uint8Array>({ cancel })));
    const result = follow();
    await vi.advanceTimersByTimeAsync(106_000);
    expect(await result).toBe(2);
    expect(JSON.parse(io.errors.join(""))).toMatchObject({
      error: { code: "observation_timeout" },
    });
    expect(request).toHaveBeenCalledTimes(3);
    expect(cancel).toHaveBeenCalledTimes(3);
  });

  it("reports lost authority before the first snapshot is disclosed", async () => {
    const { follow, io, request } = follower();
    const end = {
      ...JSON.parse(snapshot),
      type: "end",
      payload: { reason: "authorization_lost", resumable: false },
    };
    request.mockResolvedValueOnce(response(`${JSON.stringify(end)}\n`));
    expect(await follow()).toBe(2);
    expect(JSON.parse(io.errors.join(""))).toMatchObject({
      error: { code: "authorization_lost" },
      recovery: { workspaceId: workspace, runId, cursor: "opaque-live-0" },
    });
    expect(request).toHaveBeenCalledTimes(1);
  });
});
