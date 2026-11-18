import { describe, expect, it, vi } from "vitest";
import { defineAgentLoop } from "../../agent/agent.js";
import { emptyInput, numberSchema } from "../../agent/agent.test-support.js";
import { transcriptRecord } from "../../tracing/agent-transcript.test-support.js";
import { createStudioApiHandler } from "./api.js";
import { createStudioRequestHandler } from "./handler.js";
import { memoryStore, recordedRun, storedEvent } from "./events.test-support.js";

const page = {
  runId: "run",
  status: "partial" as const,
  records: [transcriptRecord(1, { kind: "assistant", text: "Private transcript content" }, "run")],
};
function apiFixture() {
  const list = vi.fn(async () => page);
  const clear = vi.fn();
  const store = memoryStore(recordedRun());
  const listEvents = vi.spyOn(store, "listEvents");
  const api = createStudioApiHandler({
    store,
    transcripts: { list },
    history: { clear },
  });
  const get = (path: string) =>
    api(new Request("http://studio.local" + path), new URL("http://studio.local" + path));
  return { api, get, list, listEvents, clear };
}

describe("Studio transcript routes", () => {
  it("exposes availability without copying transcript content into run detail", async () => {
    const { get, list } = apiFixture();
    const detail = await get("/api/runs/run");
    const payload = await detail.json();
    expect(payload.transcriptAvailable).toBe(true);
    expect(JSON.stringify(payload)).not.toContain("Private transcript content");
    expect(list).toHaveBeenCalledWith({ runId: "run", limit: 1 });
    const response = await get("/api/runs/run/transcript?afterSequence=0");
    expect(await response.json()).toEqual({
      transcript: page,
      turnRuns: {},
      live: false,
      sourceId: expect.any(String),
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("uses one history refresh for both the first and repeated transcript poll", async () => {
    const { get, list, listEvents } = apiFixture();
    await get("/api/snapshot");
    for (let poll = 0; poll < 2; poll++) {
      listEvents.mockClear();
      list.mockClear();
      expect((await get("/api/runs/run/transcript")).status).toBe(200);
      expect(listEvents.mock.calls).toEqual([
        [{ limit: 1 }],
        [{ afterId: 2, limit: expect.any(Number) }],
      ]);
      expect(list).toHaveBeenCalledExactlyOnceWith({ runId: "run", afterSequence: 0 });
    }
  });

  it.each([
    { agentRun: true, mutable: true, available: true },
    { agentRun: false, mutable: true, available: false },
    { agentRun: true, mutable: false, available: false },
  ])(
    "advertises an empty transcript view (agent=$agentRun, mutable=$mutable)",
    async ({ agentRun, mutable, available }) => {
      const agent = defineAgentLoop({
        id: "fixture",
        inputSchema: emptyInput,
        resultSchema: numberSchema,
        defaultTools: [],
        tools: {},
        initialState: () => 0,
        decide: () => ({ kind: "finish", result: 0 }),
        reduce: () => 0,
      });
      const events = recordedRun();
      if (agentRun)
        events[0] = storedEvent({
          ...events[0],
          version: 3,
          payload: {
            ...events[0].payload,
            definitionIdentity: agent.definition?.identity,
            definitionSnapshot: agent.definition,
          },
        });
      const list = vi.fn(async () => ({
        runId: "run",
        records: [],
        status: "unavailable" as const,
      }));
      const api = createStudioApiHandler({
        store: { ...memoryStore(events), ...(mutable ? { transcripts: { list } } : {}) },
        ...(mutable ? {} : { transcripts: { list } }),
      });
      const get = (path: string) =>
        api(new Request("http://studio.local" + path), new URL("http://studio.local" + path));
      expect(await (await get("/api/runs/run")).json()).toMatchObject({
        transcriptAvailable: available,
      });
      const first = await (await get("/api/runs/run/transcript")).json();
      expect(first).toMatchObject({
        live: mutable,
        sourceId: expect.any(String),
        transcript: { status: "unavailable" },
      });
      expect((await (await get("/api/runs/run/transcript")).json()).sourceId).toBe(first.sourceId);
    }
  );

  it("validates cursor and run scope before reading content", async () => {
    const { get, list } = apiFixture();
    expect((await get("/api/runs/unknown/transcript")).status).toBe(404);
    for (const value of ["-1", "1.2", "Infinity", "9007199254740992"])
      expect((await get("/api/runs/run/transcript?afterSequence=" + value)).status).toBe(400);
    expect(list).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "resolves logical turn links beyond the child window (resumed=%s)",
    async (resumed) => {
      const records = [
        { ...transcriptRecord(1), runId: "run", turn: 17 },
        { ...transcriptRecord(2), runId: "run", turn: 20 },
      ];
      const api = createStudioApiHandler({
        store: memoryStore([
          ...recordedRun(),
          ...Array.from({ length: 21 }, (_, index) => {
            const parentRunId = index === 20 ? "other-run" : "run";
            const turn = index === 20 ? 17 : index + (resumed ? 2 : 1);
            const identity = {
              pipelineId: "turn",
              runId: index === 20 ? "other-turn" : `turn-${turn}`,
              parentRunId,
              timestampMs: index + 3,
              version: 3,
              iteration: {
                runId: parentRunId,
                stepId: "agent",
                attemptId: "attempt",
                index: index + 1,
              },
            };
            return [
              storedEvent({ ...identity, id: index * 2 + 3, name: "pipeline.started" }),
              storedEvent({
                ...identity,
                id: index * 2 + 4,
                name: "step.attempted",
                stepId: "decide",
                attemptId: "decide-attempt",
                payload: {
                  attempt: 1,
                  attributes: { "agent.runId": parentRunId, "agent.turn": turn },
                },
              }),
            ];
          }).flat(),
        ]),
        transcripts: { list: async () => ({ ...page, records }) },
      });
      const get = (path: string) =>
        api(new Request("http://studio.local" + path), new URL("http://studio.local" + path));
      const detail = await (await get("/api/runs/run")).json();
      expect(detail.children).toHaveLength(16);
      expect(detail.children.some((child: { runId: string }) => child.runId === "turn-20")).toBe(
        false
      );
      const response = await get("/api/runs/run/transcript");
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        transcript: { ...page, records },
        live: false,
        sourceId: expect.any(String),
        turnRuns: { 17: "turn-17", 20: "turn-20" },
      });
    }
  );

  it("rejects adapter pages outside the requested run or cursor", async () => {
    const { get, list } = apiFixture();
    list.mockResolvedValueOnce({ ...page, runId: "other", records: [] });
    expect((await get("/api/runs/run/transcript")).status).toBe(500);
    expect((await get("/api/runs/run/transcript?afterSequence=1")).status).toBe(500);
  });

  it("does not clear history while an immutable artifact remains attached", async () => {
    const { get, api, clear } = apiFixture();
    expect(await (await get("/api/capabilities")).json()).toMatchObject({ canClearHistory: false });
    const request = new Request("http://studio.local/api/history", {
      method: "DELETE",
      headers: { "x-tubeless-studio-clear-history": "1" },
    });
    expect((await api(request, new URL(request.url))).status).toBe(405);
    expect(clear).not.toHaveBeenCalled();
  });

  it("authenticates mounted transcript routes before any reader calls", async () => {
    const { api, list } = apiFixture();
    const handler = createStudioRequestHandler({
      api,
      mount: "/admin",
      isReady: () => true,
      trustsAuthority: () => true,
      authenticate: () => new Response("denied", { status: 401 }),
      page: { csp: "default-src 'none'", html: () => "" },
    });
    const response = await handler(
      new Request("http://studio.local/admin/api/runs/run/transcript"),
      { authority: "studio.local", rawTarget: "/admin/api/runs/run/transcript" }
    );
    expect(response.status).toBe(401);
    expect(list).not.toHaveBeenCalled();
  });
});
