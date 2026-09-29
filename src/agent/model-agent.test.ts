import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { defineModelAgent, defineTool, pipelineTool, type AgentModelRequest } from "./agent.js";
import { toolObject } from "./default-tool-schema.js";

const directories: string[] = [];
async function workspace() {
  const cwd = await mkdtemp(join(tmpdir(), "tubeless-model-"));
  directories.push(cwd);
  return cwd;
}
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

describe("model agents", () => {
  it("composes model agents through pipeline tools and shares ancestor decision limits", async () => {
    const child = defineModelAgent({
      id: "child-model",
      projectContext: false,
      model: (request) => ({
        decision: { kind: "finish", result: { answer: request.task } },
        conversation: null,
      }),
    });
    const parent = (maxDecisions: number) =>
      defineModelAgent({
        id: "parent-model",
        projectContext: false,
        tools: { child: pipelineTool(child, { description: "Ask the child." }) },
        limits: { maxDecisions, maxConcurrency: 1 },
        model: (request, context) =>
          context.turn === 1
            ? {
                decision: {
                  kind: "continue",
                  calls: [{ id: "child", tool: "child", input: { task: request.task } }],
                },
                conversation: null,
              }
            : {
                decision: {
                  kind: "finish",
                  result: request.outcomes[0]!.ok
                    ? request.outcomes[0]!.value
                    : { answer: "failed" },
                },
                conversation: null,
              },
      });
    expect(await parent(3).runOrThrow({ task: "delegated" })).toEqual({ answer: "delegated" });
    const limited = await parent(2).run({ task: "delegated" });
    expect(limited.status).toBe("failed");
    expect(limited.errors[0]!.message).toContain("maxDecisions");
  });

  it("owns conversation, recovers from a tool error and completes an edit without caller schemas or reducers", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "target"), "original");
    const requests: AgentModelRequest[] = [];
    const model = vi.fn(async (request: AgentModelRequest) => {
      requests.push(request);
      const decisions = [
        { kind: "continue", calls: [{ id: "read", tool: "read", input: { path: "missing" } }] },
        { kind: "continue", calls: [{ id: "read", tool: "read", input: { path: "target" } }] },
        {
          kind: "continue",
          calls: [
            {
              id: "edit",
              tool: "edit",
              input: { path: "target", oldText: "original", newText: "updated" },
            },
          ],
        },
        { kind: "finish", result: { answer: "Updated target." } },
      ];
      if (requests.length === 2)
        expect(request.outcomes).toMatchObject([{ ok: false, error: { code: "ENOENT" } }]);
      if (requests.length === 3)
        expect(request.outcomes).toMatchObject([{ ok: true, value: { content: "original" } }]);
      expect(request.conversation).toEqual(
        requests.length === 1 ? null : { turn: requests.length - 1 }
      );
      expect(Object.isFrozen(request.outcomes)).toBe(true);
      return { decision: decisions[requests.length - 1], conversation: { turn: requests.length } };
    });
    const agent = defineModelAgent({ id: "coding", model, instructions: "Keep the answer short." });
    expectTypeOf(agent.id).toEqualTypeOf<"coding">();
    expectTypeOf(
      await agent.runOrThrow({ task: "Update target" }, undefined, { cwd })
    ).toEqualTypeOf<{ answer: string }>();
    expect(await readFile(join(cwd, "target"), "utf8")).toBe("updated");
    expect(requests[0]!.instructions).toContain("Keep the answer short.");
    expect(requests[0]!.instructions).toContain("Never claim a check passed");
    expect(requests[1]!.instructions).toBe(requests[0]!.instructions);
  });

  it("isolates concurrent runs and snapshots provider-owned state", async () => {
    const cwd = await workspace();
    const seen: string[] = [];
    const agent = defineModelAgent({
      id: "isolated",
      projectContext: false,
      model: async (request, context) => {
        if (context.turn === 1) {
          expect(request.conversation).toBeNull();
          await Promise.resolve();
          return {
            decision: { kind: "continue", calls: [{ id: "list", tool: "list", input: {} }] },
            conversation: { task: request.task },
          };
        }
        expect(request.conversation).toEqual({ task: request.task });
        expect(Object.isFrozen(request.conversation)).toBe(true);
        seen.push(request.task);
        return {
          decision: { kind: "finish", result: { answer: request.task } },
          conversation: request.conversation,
        };
      },
    });
    expect(
      await Promise.all(
        ["first", "second"].map((task) => agent.runOrThrow({ task }, undefined, { cwd }))
      )
    ).toEqual([{ answer: "first" }, { answer: "second" }]);
    await agent.runOrThrow({ task: "again" }, undefined, { cwd });
    expect(seen.sort()).toEqual(["again", "first", "second"]);
  });

  it("owns pending conversation before tool handlers can mutate provider data", async () => {
    const conversation = { nested: { value: "original" } };
    const empty = toolObject({});
    const agent = defineModelAgent({
      id: "snapshot-boundary",
      projectContext: false,
      tools: {
        mutate: defineTool({
          description: "Mutate the provider's original object.",
          inputSchema: empty,
          outputSchema: empty,
          run: () => {
            conversation.nested.value = "mutated";
            return {};
          },
        }),
      },
      model: (request, context) => {
        if (context.turn === 1)
          return {
            decision: { kind: "continue", calls: [{ id: "mutate", tool: "mutate", input: {} }] },
            conversation,
          };
        expect(conversation.nested.value).toBe("mutated");
        expect(request.conversation).toEqual({ nested: { value: "original" } });
        expect(Object.isFrozen(request.conversation)).toBe(true);
        return { decision: { kind: "finish", result: { answer: "Owned." } }, conversation: null };
      },
    });
    expect(await agent.runOrThrow({ task: "Test ownership" })).toEqual({ answer: "Owned." });
  });

  it("does no model or project-context I/O during planning and dry runs", async () => {
    const cwd = await workspace();
    await mkdir(join(cwd, "AGENTS.md"));
    const model = vi.fn();
    const agent = defineModelAgent({ id: "preview", model });
    expect(agent.plan().ok).toBe(true);
    for (const directory of [cwd, join(cwd, "missing")]) {
      const result = await agent.run({ task: "Do work" }, { dryRun: true }, { cwd: directory });
      expect(result.steps[0]?.status).toBe("skipped");
      expect(result.finalized).toBe(false);
    }
    expect(model).not.toHaveBeenCalled();
  });

  it("rejects invalid conversation state before a returned mutation starts", async () => {
    const cwd = await workspace();
    const agent = defineModelAgent({
      id: "invalid-state",
      projectContext: false,
      model: () => ({
        decision: {
          kind: "continue",
          calls: [{ id: "write", tool: "write", input: { path: "target", content: "wrong" } }],
        },
        conversation: new Map(),
      }),
    });
    await expect(agent.runOrThrow({ task: "write" }, undefined, { cwd })).rejects.toThrow();
    await expect(readFile(join(cwd, "target"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("validates default task and answer boundaries before work or finish", async () => {
    const model = vi.fn(() => ({
      decision: { kind: "finish", result: { answer: 42 } },
      conversation: null,
    }));
    const agent = defineModelAgent({ id: "validated", projectContext: false, model });
    for (const task of ["", "é".repeat(8193)])
      await expect(agent.runOrThrow({ task })).rejects.toThrow();
    expect(model).not.toHaveBeenCalled();
    await expect(agent.runOrThrow({ task: "valid" })).rejects.toThrow();
    expect(model).toHaveBeenCalledTimes(1);
  });
});
