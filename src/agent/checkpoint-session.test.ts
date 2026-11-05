import { expect, it, vi } from "vitest";
import { defer } from "../core/child-pipeline.test-support.js";
import { AgentCheckpointSession } from "./checkpoint-session.js";
import { plainAgentCheckpointCodec } from "./checkpoint-codec.js";
import { createMemoryAgentCheckpointStore } from "./memory-checkpoint-store.js";
import type { AgentCheckpointCodec, AgentCheckpointStore } from "./checkpoint-types.js";
import type { SavedCall } from "./checkpoint-format.js";

const budgets = [{ key: "agent", id: "agent" }];
const limits = { maxTurns: 10, maxCalls: 2, maxDecisions: 10, maxDepth: 1, maxConcurrency: 2 };

async function preparedSession(
  store: AgentCheckpointStore = createMemoryAgentCheckpointStore(),
  codec: AgentCheckpointCodec = plainAgentCheckpointCodec
) {
  const session = await AgentCheckpointSession.open(store, "job", codec);
  await session.enter(
    "agent",
    { definition: "fixture", options: {}, environment: "fixture", cwd: "/", cache: "use" },
    { depth: 0, limits },
    () => ({ state: { conversation: ["initial"] }, turn: 1, stateVersion: 0, calls: 0 })
  );
  const calls: SavedCall[] = ["one", "two"].map((id) => ({
    id,
    tool: "work",
    kind: "handler",
    input: {},
    replay: "safe",
    status: "pending",
  }));
  await session.acceptDecision("agent", { conversation: ["accepted"] }, calls);
  await session.admitCalls("agent", budgets, 2);
  return session;
}

it("keeps replayed outcomes and returned snapshots isolated from subsequent transitions", async () => {
  const session = await preparedSession();
  await session.startCall("agent", "one", "safe");
  const value = { messages: ["persisted"] };
  await session.completeCall("agent", "one", { id: "one", tool: "work", ok: true, value });
  value.messages.push("caller mutation");
  const replay = await session.startCall("agent", "one", "safe");
  expect(replay).toMatchObject({
    kind: "outcome",
    reused: true,
    outcome: { ok: true, value: { messages: ["persisted"] } },
  });
  if (replay.kind !== "outcome" || !replay.outcome.ok) throw new Error("Expected outcome");
  (replay.outcome.value as typeof value).messages.push("replay mutation");
  const snapshot = session.agent("agent")!;
  snapshot.execution.state = "snapshot mutation";
  session.decision("agent")!.calls.length = 0;
  await session.startCall("agent", "two", "safe");
  expect(await session.startCall("agent", "one", "safe")).toEqual({
    kind: "outcome",
    reused: true,
    outcome: { id: "one", tool: "work", ok: true, value: { messages: ["persisted"] } },
  });
  expect(session.agent("agent")!.execution.state).toEqual({ conversation: ["initial"] });
  expect(session.decision("agent")!.calls).toHaveLength(2);
  await session.close();
});

it("publishes transitions only after acknowledgement and retains concurrent call updates", async () => {
  const storage = createMemoryAgentCheckpointStore();
  const lease = await storage.acquire("job");
  const persist = lease.write;
  const write = vi.spyOn(lease, "write");
  const session = await preparedSession({ acquire: async () => lease });
  const entered = defer();
  const release = defer();
  write.mockImplementationOnce(async (bytes) => {
    entered.resolve();
    await release.promise;
    await persist(bytes);
  });
  const first = session.startCall("agent", "one", "safe");
  const second = session.startCall("agent", "two", "safe");
  await entered.promise;
  expect(session.decision("agent")!.calls.map((call) => call.status)).toEqual([
    "pending",
    "pending",
  ]);
  release.resolve();
  await Promise.all([first, second]);
  expect(session.decision("agent")!.calls.map((call) => call.status)).toEqual([
    "running",
    "running",
  ]);
  await expect(session.reserve(budgets, "maxDecisions", 11)).rejects.toMatchObject({
    code: "TUBELESS_AGENT_LIMIT_REACHED",
  });
  expect(session.budget("agent").maxDecisions).toBe(0);
  await session.reserve(budgets, "maxDecisions", 1);
  expect(session.budget("agent").maxDecisions).toBe(1);
  await session.close();
});

it.each([false, true])(
  "requires reopening after a rejected write, including an ambiguous commit (%s)",
  async (committed) => {
    const storage = createMemoryAgentCheckpointStore();
    const lease = await storage.acquire("job");
    const persist = lease.write;
    const write = vi.spyOn(lease, "write");
    const session = await preparedSession({ acquire: async () => lease });
    const failure = new Error("lost acknowledgement");
    write.mockImplementationOnce(async (bytes) => {
      if (committed) await persist(bytes);
      throw failure;
    });
    await expect(session.startCall("agent", "one", "safe")).rejects.toBe(failure);
    expect(session.decision("agent")!.calls[0]!.status).toBe("pending");
    write.mockClear();
    await expect(session.startCall("agent", "two", "safe")).rejects.toBe(failure);
    expect(write).not.toHaveBeenCalled();
    await session.close();
    const reopened = await AgentCheckpointSession.open(storage, "job");
    expect(reopened.decision("agent")!.calls[0]!.status).toBe(committed ? "running" : "pending");
    expect(await reopened.startCall("agent", "one", "safe")).toEqual({ kind: "run" });
    await reopened.close();
  }
);

it("still rejects a nondeterministic codec before acknowledging a new transition", async () => {
  let corrupt = false;
  const codec: AgentCheckpointCodec = {
    encode: plainAgentCheckpointCodec.encode,
    decode: (bytes) => {
      const decoded = plainAgentCheckpointCodec.decode(bytes);
      if (corrupt && typeof decoded === "object" && decoded !== null)
        Object.assign(decoded, { unexpected: true });
      return decoded;
    },
  };
  const session = await preparedSession(undefined, codec);
  corrupt = true;
  await expect(session.startCall("agent", "one", "safe")).rejects.toMatchObject({
    code: "TUBELESS_AGENT_CHECKPOINT_CODEC",
  });
  corrupt = false;
  expect(session.decision("agent")!.calls[0]!.status).toBe("pending");
  expect(await session.startCall("agent", "one", "safe")).toEqual({ kind: "run" });
  await session.close();
});
