import { describe, expect, expectTypeOf, it } from "vitest";
import {
  createAgentSession,
  createMemoryAgentCheckpointStore,
  plainAgentCheckpointCodec,
  type AgentCheckpointStore,
  defineAgent,
  defineAgentLoop,
  defineTool,
  type DefaultAgentToolName,
  type AgentModel,
  type AgentModelRequest,
} from "./agent.js";
import { emptyInput, textSchema, schema } from "./agent.test-support.js";
import { toolObject } from "./default-tool-schema.js";
import { remote } from "./environment.test-support.js";
import type { Checkpoint } from "./checkpoint-format.js";
import { wireArray, wireString } from "../tracing/wire-schema.js";

/** A provider that appends each task, and fails tasks named "fail", recording what it saw. */
function chatModel() {
  const requests: AgentModelRequest[] = [];
  const model: AgentModel = (request) => {
    requests.push(request);
    if (request.task === "fail") throw new Error("provider failed");
    const conversation = [...((request.conversation as string[] | null) ?? []), request.task];
    return {
      decision: { kind: "finish", result: { answer: conversation.join(" > ") } },
      conversation,
    };
  };
  return { model, requests };
}

const agent = (model: AgentModel) =>
  defineAgent({ id: "chat", projectContext: false, environment: remote(), model });

describe("agent sessions", () => {
  it("restores a completed durable conversation without replaying the model or finish transform", async () => {
    const { model, requests } = chatModel();
    let transforms = 0;
    const chat = defineAgent({
      id: "durable-chat",
      model,
      projectContext: false,
      environment: remote(),
      defaultTools: [],
      implementationVersion: "v1",
      durability: { store: createMemoryAgentCheckpointStore(), key: ({ task }) => task },
      resultSchema: schema<{ answer: string }>((value) => {
        transforms++;
        return { value: value as { answer: string } };
      }),
    });
    const original = createAgentSession(chat);
    expect(await original.runOrThrow({ task: "first" })).toEqual({ answer: "first" });
    const replay = createAgentSession(chat);
    expect(await replay.runOrThrow({ task: "first" })).toEqual({ answer: "first" });
    expect(requests).toHaveLength(1);
    expect(transforms).toBe(1);
    expect(replay.conversation).toEqual(["first"]);
    expect(Object.isFrozen(replay.conversation)).toBe(true);
    expect(await replay.runOrThrow({ task: "second" })).toEqual({ answer: "first > second" });
    expect(requests[1]!.conversation).toEqual(["first"]);
  });

  it.each([undefined, null])(
    "restores an empty durable finish conversation: %s",
    async (conversation) => {
      const requests: AgentModelRequest[] = [];
      const chat = defineAgent({
        id: "empty-finish",
        projectContext: false,
        environment: remote(),
        defaultTools: [],
        implementationVersion: "v1",
        durability: { store: createMemoryAgentCheckpointStore(), key: ({ task }) => task },
        model: (request) => {
          requests.push(request);
          return { decision: { kind: "finish", result: { answer: request.task } }, conversation };
        },
      });
      await chat.runOrThrow({ task: "first" });
      const session = createAgentSession(chat, { conversation: ["stale"] });
      await session.runOrThrow({ task: "first" });
      expect(session.conversation).toBeNull();
      await session.runOrThrow({ task: "second" });
      expect(requests).toHaveLength(2);
      expect(requests[1]!.conversation).toBeNull();
    }
  );

  it("restores the finish response after tool turns without repeating tools", async () => {
    let calls = 0;
    let decisions = 0;
    const chat = defineAgent({
      id: "tool-finish",
      projectContext: false,
      environment: remote(),
      defaultTools: [],
      implementationVersion: "v1",
      durability: { store: createMemoryAgentCheckpointStore(), key: "task" },
      tools: {
        probe: defineTool({
          description: "Probe",
          inputSchema: emptyInput,
          outputSchema: textSchema,
          run: () => {
            calls++;
            return "observed";
          },
        }),
      },
      model: (_request, context) => {
        decisions++;
        return context.turn === 1
          ? {
              decision: { kind: "continue", calls: [{ id: "probe", tool: "probe", input: {} }] },
              conversation: ["before-finish"],
            }
          : { decision: { kind: "finish", result: { answer: "done" } }, conversation: ["final"] };
      },
    });
    await chat.runOrThrow({ task: "first" });
    const session = createAgentSession(chat);
    expect(await session.runOrThrow({ task: "first" })).toEqual({ answer: "done" });
    expect(session.conversation).toEqual(["final"]);
    expect(decisions).toBe(2);
    expect(calls).toBe(1);
  });

  it("keeps legacy result replay but rejects session replay without the final conversation", async () => {
    const base = createMemoryAgentCheckpointStore();
    let legacy = false;
    const store: AgentCheckpointStore = {
      acquire: async (key) => {
        const lease = await base.acquire(key);
        return {
          ...lease,
          read: async () => {
            const bytes = await lease.read();
            if (!legacy || bytes === undefined) return bytes;
            const checkpoint = plainAgentCheckpointCodec.decode(bytes) as Checkpoint;
            for (const saved of Object.values(checkpoint.agents))
              if (saved.phase === "completed") delete saved.completedState;
            return plainAgentCheckpointCodec.encode(checkpoint);
          },
        };
      },
    };
    const { model, requests } = chatModel();
    const chat = defineAgent({
      id: "legacy",
      model,
      projectContext: false,
      environment: remote(),
      defaultTools: [],
      implementationVersion: "v1",
      durability: { store, key: "task" },
    });
    await chat.runOrThrow({ task: "first" });
    legacy = true;
    expect(await chat.runOrThrow({ task: "first" })).toEqual({ answer: "first" });
    const session = createAgentSession(chat, { conversation: ["preserved"] });
    await expect(session.runOrThrow({ task: "first" })).rejects.toThrow("no final conversation");
    expect(session.conversation).toEqual(["preserved"]);
    expect(await chat.runOrThrow({ task: "first" })).toEqual({ answer: "first" });
    expect(requests).toHaveLength(1);
  });

  it("does not revive a durable conversation cleared during checkpoint loading", async () => {
    const base = createMemoryAgentCheckpointStore();
    let paused = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const store: AgentCheckpointStore = {
      acquire: async (key) => {
        const lease = await base.acquire(key);
        return {
          ...lease,
          read: async () => {
            if (paused) await gate;
            return lease.read();
          },
        };
      },
    };
    const { model } = chatModel();
    const chat = defineAgent({
      id: "clear-replay",
      model,
      projectContext: false,
      environment: remote(),
      defaultTools: [],
      implementationVersion: "v1",
      durability: { store, key: "task" },
    });
    await chat.runOrThrow({ task: "first" });
    const session = createAgentSession(chat);
    paused = true;
    const running = session.run({ task: "first" });
    session.clear();
    release();
    expect((await running).status).toBe("completed");
    expect(session.conversation).toBeNull();
  });

  it("does not commit an invalid durable finish result", async () => {
    const session = createAgentSession(
      defineAgent({
        id: "invalid-finish",
        projectContext: false,
        environment: remote(),
        defaultTools: [],
        implementationVersion: "v1",
        durability: { store: createMemoryAgentCheckpointStore(), key: "task" },
        model: () => ({
          decision: { kind: "finish", result: { answer: 123 } },
          conversation: ["invalid"],
        }),
      }),
      { conversation: ["preserved"] }
    );
    expect((await session.run({ task: "first" })).status).toBe("failed");
    expect(session.conversation).toEqual(["preserved"]);
  });

  it("keeps context when durable completion cannot be acknowledged", async () => {
    const base = createMemoryAgentCheckpointStore();
    const store: AgentCheckpointStore = {
      acquire: async (key) => {
        const lease = await base.acquire(key);
        return {
          ...lease,
          write: async (bytes) => {
            const checkpoint = plainAgentCheckpointCodec.decode(bytes) as Checkpoint;
            if (Object.values(checkpoint.agents).some((saved) => saved.phase === "completed"))
              throw new Error("completion storage failed");
            await lease.write(bytes);
          },
        };
      },
    };
    const session = createAgentSession(
      defineAgent({
        id: "unacknowledged-finish",
        model: chatModel().model,
        projectContext: false,
        environment: remote(),
        defaultTools: [],
        implementationVersion: "v1",
        durability: { store, key: "task" },
      }),
      { conversation: ["preserved"] }
    );
    await expect(session.runOrThrow({ task: "first" })).rejects.toThrow(
      "completion storage failed"
    );
    expect(session.conversation).toEqual(["preserved"]);
  });

  it("keeps prior context for dry and already cancelled durable runs", async () => {
    const { model, requests } = chatModel();
    const chat = defineAgent({
      id: "preview-chat",
      model,
      projectContext: false,
      environment: remote(),
      defaultTools: [],
      implementationVersion: "v1",
      durability: { store: createMemoryAgentCheckpointStore(), key: ({ task }) => task },
    });
    const session = createAgentSession(chat, { conversation: ["preserved"] });
    expect((await session.run({ task: "dry" }, { dryRun: true })).finalized).toBe(false);
    const controller = new AbortController();
    controller.abort();
    expect(
      (await session.run({ task: "cancelled" }, undefined, { signal: controller.signal })).status
    ).toBe("cancelled");
    expect(requests).toHaveLength(0);
    expect(session.conversation).toEqual(["preserved"]);
  });

  it("continues one conversation across prompts and keeps it after failures", async () => {
    const { model, requests } = chatModel();
    const session = createAgentSession(agent(model));
    expectTypeOf(session.runOrThrow).returns.resolves.toEqualTypeOf<{ answer: string }>();
    expect(await session.runOrThrow({ task: "hello" })).toEqual({ answer: "hello" });
    expect(session.conversation).toEqual(["hello"]);
    const failed = await session.run({ task: "fail" });
    expect(failed.status).toBe("failed");
    expect(session.conversation).toEqual(["hello"]);
    await expect(session.runOrThrow({ task: "fail" })).rejects.toThrow("provider failed");
    expect(await session.runOrThrow({ task: "again" })).toEqual({ answer: "hello > again" });
    expect(requests.map(({ conversation }) => conversation)).toEqual([
      null,
      ["hello"],
      ["hello"],
      ["hello"],
    ]);
    session.clear();
    expect(session.conversation).toBeNull();
    expect(await session.runOrThrow({ task: "fresh" })).toEqual({ answer: "fresh" });
  });

  it("resumes a persisted conversation and leaves the original agent stateless", async () => {
    const { model } = chatModel();
    const chat = agent(model);
    const session = createAgentSession(chat, { conversation: ["stored"] });
    expect(await session.runOrThrow({ task: "next" })).toEqual({ answer: "stored > next" });
    expect(await chat.runOrThrow({ task: "solo" })).toEqual({ answer: "solo" });
    expect(Object.isFrozen(session.conversation)).toBe(true);
  });

  it("keeps the defined model, tool grants, limits and descriptors after caller mutations", async () => {
    const defaults: DefaultAgentToolName[] = [];
    const probe = defineTool({
      description: "Probe",
      inputSchema: emptyInput,
      outputSchema: textSchema,
      run: () => "probe",
    });
    const tools: Record<string, typeof probe> = { probe };
    const limits = { maxTurns: 1 };
    const descriptor = {
      type: "object",
      properties: { answer: { type: "string" } },
      required: ["answer"],
      additionalProperties: false,
    };
    const requests: AgentModelRequest[] = [];
    let prefix = "current";
    const config = {
      id: "owned-definition",
      model: ((request, context) => {
        requests.push(request);
        expect(context.resultJsonSchema).toEqual(descriptorAtDefinition);
        return {
          decision: {
            kind: "finish",
            result: {
              answer: `${prefix}:${context.capabilities.map((tool) => tool.name).join(",")}`,
            },
          },
          conversation: [request.task],
        };
      }) satisfies AgentModel,
      instructions: "Original instructions",
      projectContext: false,
      environment: remote(),
      defaultTools: defaults,
      tools,
      limits,
      resultJsonSchema: descriptor,
    };
    const descriptorAtDefinition = structuredClone(descriptor);
    const chat = defineAgent(config);
    config.model = () => ({
      decision: { kind: "finish", result: { answer: "replacement" } },
      conversation: [],
    });
    config.instructions = "Changed instructions";
    defaults.push("bash");
    delete tools.probe;
    tools.other = probe;
    limits.maxTurns = 0;
    descriptor.properties.answer.type = "number";
    prefix = "live"; // Captured service behavior remains live; configuration ownership does not freeze closures.
    const session = createAgentSession(chat);
    const original = await chat.run({ task: "solo" });
    const continued = await session.run({ task: "hello" });
    expect(original.value).toEqual({ answer: "live:probe" });
    expect(continued.value).toEqual(original.value);
    expect(continued.definitionIdentity).toEqual(original.definitionIdentity);
    expect(
      requests.every(
        (request) =>
          request.instructions.includes("Original instructions") &&
          !request.instructions.includes("Changed instructions")
      )
    ).toBe(true);
    expect(session.conversation).toEqual(["hello"]);
    expect(createAgentSession(chat).conversation).toBeNull();
  });

  it("rejects overlapping runs and agents without a model", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const session = createAgentSession(
      agent(async () => {
        await gate;
        return { decision: { kind: "finish", result: { answer: "done" } }, conversation: null };
      })
    );
    const first = session.run({ task: "slow" });
    await expect(session.run({ task: "overlap" })).rejects.toThrow(
      "Agent session is already running"
    );
    release();
    expect((await first).status).toBe("completed");
    const loop = defineAgentLoop({
      id: "loop",
      inputSchema: emptyInput,
      resultSchema: textSchema,
      initialState: () => null,
      decide: () => ({ kind: "finish", result: "" }),
    });
    // Loops own their state; only model-backed agents carry a provider conversation.
    expect(() => createAgentSession(loop)).toThrow("requires an agent from defineAgent");
  });

  it("supports typed agents", async () => {
    const { model, requests } = chatModel();
    const typed = defineAgent({
      id: "typed-chat",
      environment: remote(),
      inputSchema: toolObject({ topics: wireArray(wireString(), {}) }),
      task: ({ topics }) => topics.join(", "),
      model,
    });
    const session = createAgentSession(typed);
    await session.runOrThrow({ topics: ["a", "b"] });
    await session.runOrThrow({ topics: ["c"] });
    expect(requests.map(({ task, conversation }) => [task, conversation])).toEqual([
      ["a, b", null],
      ["c", ["a, b"]],
    ]);
  });

  it("does not revive a conversation cleared while its run was active", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const session = createAgentSession(
      agent(async (request) => {
        await gate;
        return {
          decision: { kind: "finish", result: { answer: request.task } },
          conversation: [request.task],
        };
      })
    );
    const running = session.run({ task: "pending" });
    session.clear();
    release();
    expect((await running).status).toBe("completed");
    expect(session.conversation).toBeNull();
  });

  it("commits an observed undefined conversation instead of keeping stale context", async () => {
    const requests: AgentModelRequest[] = [];
    let conversation: unknown = ["first"];
    const session = createAgentSession(
      agent((request) => {
        requests.push(request);
        return {
          decision: { kind: "finish", result: { answer: request.task } },
          conversation,
        };
      })
    );
    await session.runOrThrow({ task: "one" });
    conversation = undefined;
    await session.runOrThrow({ task: "two" });
    await session.runOrThrow({ task: "three" });
    expect(requests.map((request) => request.conversation)).toEqual([null, ["first"], null]);
    expect(session.conversation).toBeNull();
  });
});
