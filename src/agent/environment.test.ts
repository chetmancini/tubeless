import { expect, it, vi } from "vitest";
import { createSteps, definePipeline } from "../core/pipeline.js";
import { defineModelAgent, defineTool, pipelineTool } from "./agent.js";
import type { AgentEnvironment } from "./environment.js";
import { toolObject } from "./default-tool-schema.js";

function remote(): AgentEnvironment {
  return {
    id: "container:one",
    resolveCwd: vi.fn(() => "/remote/project"),
    projectInstructions: vi.fn(() => [
      { path: "/remote/project/AGENTS.md", content: "REMOTE GUIDANCE" },
    ]),
    read: vi.fn(() => ({
      path: "/remote/project/a",
      content: "before",
      startLine: 1,
      endLine: 1,
      totalLines: 1,
      truncated: false,
    })),
    write: vi.fn(() => ({ path: "/remote/project/a", bytes: 5 })),
    edit: vi.fn(() => ({ path: "/remote/project/a", bytes: 5 })),
    bash: vi.fn(() => ({
      cwd: "/remote/project",
      stdout: "verified",
      stderr: "",
      exitCode: 0,
      signal: null,
      timedOut: false,
      truncated: false,
    })),
    list: vi.fn(() => ({
      path: "/remote/project",
      entries: [{ name: "a", kind: "file" as const }],
      truncated: false,
    })),
    search: vi.fn(() => ({
      matches: [{ path: "/remote/project/a", line: 1, text: "before" }],
      truncated: false,
      skippedFiles: 0,
    })),
  };
}

it("routes all workspace operations, guidance and custom tools through a remote environment", async () => {
  const environment = remote();
  const factory = vi.fn(() => environment);
  const empty = toolObject({});
  const agent = defineModelAgent({
    id: "remote-workspace",
    environment: factory,
    tools: {
      custom: defineTool({
        description: "Use workspace authority",
        inputSchema: empty,
        outputSchema: empty,
        run: (_input, context) => {
          expect(context.environment).toBe(environment);
          expect(context.cwd).toBe("/remote/project");
          return {};
        },
      }),
    },
    model: (request, context) => {
      expect(request.instructions).toContain("REMOTE GUIDANCE");
      expect(context.environment).toBe(environment);
      expect(context.cwd).toBe("/remote/project");
      return {
        conversation: null,
        decision:
          context.turn === 1
            ? {
                kind: "continue",
                calls: [
                  { id: "read", tool: "read", input: { path: "a" } },
                  { id: "write", tool: "write", input: { path: "a", content: "after" } },
                  {
                    id: "edit",
                    tool: "edit",
                    input: { path: "a", oldText: "after", newText: "AFTER" },
                  },
                  { id: "bash", tool: "bash", input: { command: "verify" } },
                  { id: "list", tool: "list", input: {} },
                  { id: "search", tool: "search", input: { query: "before" } },
                  { id: "custom", tool: "custom", input: {} },
                ],
              }
            : { kind: "finish", result: { answer: "remote" } },
      };
    },
  });
  expect(
    await agent.runOrThrow({ task: "Work remotely" }, undefined, { cwd: "/does-not-exist-locally" })
  ).toEqual({ answer: "remote" });
  expect(factory).toHaveBeenCalledTimes(1);
  expect(environment.resolveCwd).toHaveBeenCalledTimes(1);
  for (const method of [
    "read",
    "write",
    "edit",
    "bash",
    "list",
    "search",
    "projectInstructions",
  ] as const)
    expect(environment[method]).toHaveBeenCalledTimes(1);
});

it("inherits workspace authority through ordinary pipelines between parent and child agents", async () => {
  const environment = remote();
  const child = defineModelAgent({
    id: "remote-child",
    model: (request, context) => {
      expect(context.environment).toBe(environment);
      expect(request.instructions).toContain("REMOTE GUIDANCE");
      return { conversation: null, decision: { kind: "finish", result: { answer: context.cwd } } };
    },
  });
  const { fromPipeline } = createSteps(child.optionsSchema);
  const nested = fromPipeline("nested", { pipeline: child });
  const wrapper = definePipeline({ id: "remote-wrapper", steps: [nested], finalize: nested });
  const parent = defineModelAgent({
    id: "remote-parent",
    environment,
    tools: { child: pipelineTool(wrapper, { description: "Delegate" }) },
    model: (request, context) => ({
      conversation: null,
      decision:
        context.turn === 1
          ? {
              kind: "continue",
              calls: [{ id: "child", tool: "child", input: { task: "Report cwd" } }],
            }
          : { kind: "finish", result: { answer: JSON.stringify(request.outcomes) } },
    }),
  });
  expect(
    (await parent.runOrThrow({ task: "Delegate" }, undefined, { cwd: "/missing-local" })).answer
  ).toContain("/remote/project");
});

it("validates remote results and arguments at the same schema boundary as local tools", async () => {
  const environment = remote();
  environment.read = vi.fn(
    () =>
      ({
        path: "a",
        content: "x",
        startLine: 1,
        endLine: 1,
        totalLines: 1,
        truncated: "invalid",
      }) as never
  );
  const agent = defineModelAgent({
    id: "invalid-remote-result",
    environment,
    model: () => ({
      conversation: null,
      decision: { kind: "continue", calls: [{ id: "read", tool: "read", input: { path: "a" } }] },
    }),
  });
  expect((await agent.run({ task: "Read" })).status).toBe("failed");
  expect(environment.read).toHaveBeenCalledTimes(1);
  const invalid = defineModelAgent({
    id: "invalid-remote-args",
    environment,
    model: () => ({
      conversation: null,
      decision: { kind: "continue", calls: [{ id: "read", tool: "read", input: { path: 2 } }] },
    }),
  });
  expect((await invalid.run({ task: "Read" })).status).toBe("failed");
  expect(environment.read).toHaveBeenCalledTimes(1);
});

it("keeps environment factories out of plans and skipped model dry runs", async () => {
  const factory = vi.fn(() => remote());
  const model = vi.fn();
  const agent = defineModelAgent({ id: "environment-preview", environment: factory, model });
  expect(agent.plan().ok).toBe(true);
  await agent.run({ task: "Preview" }, { dryRun: true }, { cwd: "/missing" });
  expect(factory).not.toHaveBeenCalled();
  expect(model).not.toHaveBeenCalled();
});

it("lets a child explicitly replace inherited workspace authority", async () => {
  const parentEnvironment = remote();
  const childEnvironment = {
    ...remote(),
    id: "container:two",
    resolveCwd: vi.fn(() => "/remote/child"),
  };
  const child = defineModelAgent({
    id: "overridden-child",
    environment: childEnvironment,
    projectContext: false,
    model: (_request, context) => {
      expect(context.environment).toBe(childEnvironment);
      return { conversation: null, decision: { kind: "finish", result: { answer: context.cwd } } };
    },
  });
  const parent = defineModelAgent({
    id: "overridden-parent",
    environment: parentEnvironment,
    projectContext: false,
    tools: { child: pipelineTool(child, { description: "Delegate to another workspace" }) },
    model: (request, context) => {
      expect(context.environment).toBe(parentEnvironment);
      expect(context.cwd).toBe("/remote/project");
      return {
        conversation: null,
        decision:
          context.turn === 1
            ? {
                kind: "continue",
                calls: [{ id: "child", tool: "child", input: { task: "Report cwd" } }],
              }
            : { kind: "finish", result: { answer: JSON.stringify(request.outcomes) } },
      };
    },
  });
  expect((await parent.runOrThrow({ task: "Delegate" })).answer).toContain("/remote/child");
  expect(parentEnvironment.resolveCwd).toHaveBeenCalledTimes(1);
  expect(childEnvironment.resolveCwd).toHaveBeenCalledTimes(1);
});

it("fails explicit invalid environments and rejected factories without falling back to the host", async () => {
  const model = vi.fn(() => ({
    conversation: null,
    decision: { kind: "finish", result: { answer: "host fallback" } },
  }));
  for (const environment of [
    null as never,
    async () => {
      throw new Error("Remote workspace unavailable");
    },
  ]) {
    const agent = defineModelAgent({ id: "unavailable-environment", environment, model });
    expect((await agent.run({ task: "Work remotely" })).status).toBe("failed");
  }
  expect(model).not.toHaveBeenCalled();
});

it("resolves asynchronous factories independently for concurrent invocations", async () => {
  const factory = vi.fn(async (context: { cwd: string }) => ({
    ...remote(),
    id: context.cwd,
    resolveCwd: () => context.cwd,
    projectInstructions: () => [],
  }));
  const agent = defineModelAgent({
    id: "concurrent-environments",
    environment: factory,
    model: (_request, context) => {
      expect(context.environment.id).toBe(context.cwd);
      return {
        conversation: null,
        decision: { kind: "finish", result: { answer: context.environment.id } },
      };
    },
  });
  expect(
    await Promise.all(
      ["/remote/one", "/remote/two"].map((cwd) =>
        agent.runOrThrow({ task: "Report workspace" }, undefined, { cwd })
      )
    )
  ).toEqual([{ answer: "/remote/one" }, { answer: "/remote/two" }]);
  expect(factory).toHaveBeenCalledTimes(2);
});
