import { describe, expect, expectTypeOf, it } from "vitest";
import {
  createAgentSession,
  defineAgent,
  defineAgentLoop,
  defineTool,
  type DefaultAgentToolName,
  type AgentModel,
  type AgentModelRequest,
} from "./agent.js";
import { emptyInput, textSchema } from "./agent.test-support.js";
import { toolObject } from "./default-tool-schema.js";
import { remote } from "./environment.test-support.js";
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
