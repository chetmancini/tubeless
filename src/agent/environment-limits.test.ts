import { expect, it, vi } from "vitest";
import type { AgentCall } from "./agent.js";
import { remote, workspaceAgent } from "./environment.test-support.js";

it.each([false, true])(
  "rejects oversized remote reads before committing state (dryRun=%s)",
  async (dryRun) => {
    for (const content of ["x".repeat(16_385), "é".repeat(8193)]) {
      const environment = remote();
      environment.read = vi.fn(() => ({
        path: "/remote/a",
        content,
        startLine: 1,
        endLine: 1,
        totalLines: 1,
        truncated: true,
      }));
      const { agent, decide, reduce } = workspaceAgent(environment, [
        { id: "read", tool: "read", input: { path: "a" } },
      ]);
      expect((await agent.run({}, { dryRun })).status).toBe("failed");
      expect(environment.read).toHaveBeenCalledTimes(1);
      expect(reduce).not.toHaveBeenCalled();
      expect(decide).toHaveBeenCalledTimes(1);
    }
  }
);

it.each([false, true])(
  "rejects oversized remote listing names before committing state (dryRun=%s)",
  async (dryRun) => {
    for (const name of ["x".repeat(128), "é".repeat(64)]) {
      const environment = remote();
      environment.list = vi.fn(() => ({
        path: "/remote",
        entries: Array.from({ length: 129 }, () => ({ name, kind: "file" as const })),
        truncated: true,
      }));
      const { agent, decide, reduce } = workspaceAgent(environment, [
        { id: "list", tool: "list", input: { path: null } },
      ]);
      expect((await agent.run({}, { dryRun })).status).toBe("failed");
      expect(environment.list).toHaveBeenCalledTimes(1);
      expect(reduce).not.toHaveBeenCalled();
      expect(decide).toHaveBeenCalledTimes(1);
    }
  }
);

it.each([false, true])(
  "preserves reads and listings at their UTF-8 byte limits (dryRun=%s)",
  async (dryRun) => {
    const environment = remote();
    const read = {
      path: "/remote/a",
      content: "🙂".repeat(4096),
      startLine: 1,
      endLine: 1,
      totalLines: 1,
      truncated: false,
    };
    const list = {
      path: "/remote/" + "é".repeat(512),
      entries: Array.from({ length: 128 }, (_, index) => ({
        name: String(index).padStart(3, "0") + "é".repeat(62) + "x",
        kind: "file" as const,
      })),
      truncated: false,
    };
    environment.read = vi.fn(() => read);
    environment.list = vi.fn(() => list);
    const { agent, decide, reduce } = workspaceAgent(environment, [
      { id: "read", tool: "read", input: { path: "a" } },
      { id: "list", tool: "list", input: { path: null } },
    ]);
    expect(JSON.parse(await agent.runOrThrow({}, { dryRun }))).toEqual([
      { id: "read", tool: "read", ok: true, value: read },
      { id: "list", tool: "list", ok: true, value: list },
    ]);
    expect(reduce).toHaveBeenCalledTimes(1);
    expect(decide).toHaveBeenCalledTimes(2);
  }
);

it("rejects oversized remote bash output before committing state", async () => {
  for (const output of [
    { stdout: "x".repeat(16_385), stderr: "" },
    { stdout: "é".repeat(8193), stderr: "" },
    { stdout: "é".repeat(4096), stderr: "🙂".repeat(2049) },
  ]) {
    const environment = remote();
    environment.bash = vi.fn(() => ({
      ...output,
      cwd: "/remote",
      exitCode: 0,
      signal: null,
      timedOut: false,
      truncated: true,
    }));
    const { agent, decide, reduce } = workspaceAgent(environment, [
      { id: "bash", tool: "bash", input: { command: "verify" } },
    ]);
    expect((await agent.run({})).status).toBe("failed");
    expect(environment.bash).toHaveBeenCalledTimes(1);
    expect(reduce).not.toHaveBeenCalled();
    expect(decide).toHaveBeenCalledTimes(1);
  }
});

it("preserves bash output at the combined UTF-8 byte limit", async () => {
  const environment = remote();
  const output = {
    cwd: "/remote",
    stdout: "🙂".repeat(2048),
    stderr: "é".repeat(4096),
    exitCode: 0,
    signal: null,
    timedOut: false,
    truncated: false,
  };
  environment.bash = vi.fn(() => output);
  const { agent } = workspaceAgent(environment, [
    { id: "bash", tool: "bash", input: { command: "verify" } },
  ]);
  expect(JSON.parse(await agent.runOrThrow({}))).toEqual([
    { id: "bash", tool: "bash", ok: true, value: output },
  ]);
});

const mutationCases = [
  {
    label: "write.content",
    call: (text: string): AgentCall => ({
      id: "write",
      tool: "write",
      input: { path: "a", content: text },
    }),
  },
  {
    label: "edit.oldText",
    call: (text: string): AgentCall => ({
      id: "edit",
      tool: "edit",
      input: { path: "a", oldText: text, newText: "new" },
    }),
  },
  {
    label: "edit.newText",
    call: (text: string): AgentCall => ({
      id: "edit",
      tool: "edit",
      input: { path: "a", oldText: "old", newText: text },
    }),
  },
];

it.each(mutationCases)(
  "rejects oversized UTF-8 $label before dispatching any batch call",
  async ({ call }) => {
    const environment = remote();
    const { agent, decide, reduce } = workspaceAgent(environment, [
      { id: "first", tool: "write", input: { path: "first", content: "valid" } },
      call("é".repeat(524_289)),
    ]);
    expect((await agent.run({})).status).toBe("failed");
    expect(environment.write).not.toHaveBeenCalled();
    expect(environment.edit).not.toHaveBeenCalled();
    expect(reduce).not.toHaveBeenCalled();
    expect(decide).toHaveBeenCalledTimes(1);
  }
);

it.each(mutationCases)(
  "dispatches UTF-8 $label at the 1 MiB boundary unchanged",
  async ({ call }) => {
    const environment = remote();
    const request = call("🙂".repeat(262_144));
    const { agent } = workspaceAgent(environment, [request]);
    expect(JSON.parse(await agent.runOrThrow({}))).toMatchObject([
      { id: request.id, tool: request.tool, ok: true },
    ]);
    const handler = vi.mocked(environment[request.tool]);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(handler.mock.calls[0]?.[0]) === JSON.stringify(request.input)).toBe(true);
  }
);
