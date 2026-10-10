import { describe, expect, it, vi } from "vitest";
import type { PipelineLogger, PipelineStepProgress } from "../core/pipeline.js";
import { ToolError } from "./tools.js";
import { remote, workspaceAgent } from "./environment.test-support.js";

function capture() {
  const messages: string[] = [];
  const progress: PipelineStepProgress[] = [];
  const log: PipelineLogger = {
    log: (message) => messages.push(String(message)),
    warn: (message) => messages.push(String(message)),
    error: (message) => messages.push(String(message)),
  };
  return {
    messages,
    progress,
    context: {
      log,
      hooks: {
        onStepProgress: (event: { progress: PipelineStepProgress }) =>
          progress.push(event.progress),
      },
    },
  };
}

describe("workspace tool activity", () => {
  it("reports each action and its result through logs and nested DAG details", async () => {
    const captured = capture();
    const { agent } = workspaceAgent(remote(), [
      { id: "opaque-1", tool: "read", input: { path: "src/app.ts" } },
      {
        id: "opaque-2",
        tool: "write",
        input: { path: "src/new.ts", content: "PRIVATE FILE CONTENT" },
      },
      {
        id: "opaque-3",
        tool: "edit",
        input: { path: "src/app.ts", oldText: "PRIVATE OLD TEXT", newText: "PRIVATE NEW TEXT" },
      },
      { id: "opaque-4", tool: "bash", input: { command: "bun test", cwd: "packages/app" } },
      { id: "opaque-5", tool: "list", input: { path: null } },
      { id: "opaque-6", tool: "search", input: { query: "TODO", path: "src" } },
    ]);
    await agent.runOrThrow({}, undefined, captured.context);
    const expected = [
      'Read "src/app.ts": completed (lines 1-1 of 1)',
      'Write "src/new.ts": completed (5 bytes)',
      'Edit "src/app.ts": completed (5 bytes)',
      'Run bash "bun test" in "packages/app": completed (exit 0)',
      'List ".": completed (1 entry)',
      'Search "TODO" in "src": completed (1 match, 0 files skipped)',
    ];
    expect(captured.messages).toEqual(expect.arrayContaining(expected));
    const rows = captured.progress.flatMap(({ details }) => details ?? []);
    for (const message of expected) expect(rows.some(({ label }) => label === message)).toBe(true);
    expect(rows).toContainEqual(expect.objectContaining({ id: "iteration-1", name: "Turn 1" }));
    expect(rows).toContainEqual(
      expect.objectContaining({ id: "iteration-1/opaque-1", name: "read", status: "completed" })
    );
    expect(JSON.stringify(captured)).not.toContain("PRIVATE");
    expect(JSON.stringify(captured)).not.toContain("verified");
  });

  it("shows the active file before an asynchronous read finishes", async () => {
    const environment = remote();
    let release!: (value: Awaited<ReturnType<typeof environment.read>>) => void;
    const reply = new Promise<Awaited<ReturnType<typeof environment.read>>>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    vi.mocked(environment.read).mockImplementation(() => {
      started();
      return reply;
    });
    const captured = capture();
    const { agent } = workspaceAgent(environment, [
      { id: "call-1", tool: "read", input: { path: "src/slow.ts" } },
    ]);
    const running = agent.run({}, undefined, captured.context);
    await ready;
    expect(captured.messages).toEqual(['Read "src/slow.ts"']);
    expect(captured.progress.flatMap(({ details }) => details ?? [])).toContainEqual(
      expect.objectContaining({ name: "read", status: "running", label: 'Read "src/slow.ts"' })
    );
    release({
      path: "src/slow.ts",
      content: "",
      startLine: 1,
      endLine: 0,
      totalLines: 0,
      truncated: false,
    });
    expect((await running).status).toBe("completed");
    expect(captured.messages).toContain('Read "src/slow.ts": completed (empty file)');
  });

  it("reports a recoverable tool failure without a completed action", async () => {
    const environment = remote();
    vi.mocked(environment.read).mockImplementation(() => {
      throw new ToolError("READ_FAILED", "fixture read failed");
    });
    const captured = capture();
    const { agent } = workspaceAgent(environment, [
      { id: "call-1", tool: "read", input: { path: "missing" } },
    ]);
    const result = await agent.run({}, undefined, captured.context);
    expect(result.status).toBe("completed");
    expect(captured.messages).toEqual(['Read "missing"', 'Read "missing": failed']);
    expect(captured.progress.flatMap(({ details }) => details ?? [])).toContainEqual(
      expect.objectContaining({ name: "read", status: "failed" })
    );
  });

  it.each([
    {
      tool: "read" as const,
      output: {
        path: "a",
        content: "x",
        startLine: 1,
        endLine: 1,
        totalLines: 1,
        truncated: "invalid",
      },
      action: 'Read "a"',
      error: "tool.truncated must be a boolean",
    },
    {
      tool: "list" as const,
      output: { path: "a", entries: null, truncated: false },
      action: 'List "a"',
      error: "tool.entries must be an array",
    },
  ])(
    "validates malformed $tool output before formatting or publishing completion",
    async ({ tool, output, action, error }) => {
      const environment = remote();
      // Deliberately violate the adapter contract to exercise the runtime boundary.
      vi.mocked(environment[tool]).mockReturnValue(output as never);
      const captured = capture();
      const { agent } = workspaceAgent(environment, [{ id: "call-1", tool, input: { path: "a" } }]);
      const result = await agent.run({}, undefined, captured.context);
      expect(result.status).toBe("failed");
      expect(result.errors[0]?.message).toContain("TUBELESS_STEP_OUTPUT_VALIDATION_FAILED");
      expect(result.errors[0]?.message).toContain(error);
      expect(captured.messages).toEqual([action, `${action}: failed`]);
      expect(captured.progress.flatMap(({ details }) => details ?? [])).toContainEqual(
        expect.objectContaining({ name: tool, status: "failed" })
      );
    }
  );

  it("reports cancellation and preserves cancellation semantics for a late adapter result", async () => {
    const environment = remote();
    const controller = new AbortController();
    vi.mocked(environment.read).mockImplementation(() => {
      controller.abort();
      return Promise.resolve({
        path: "a",
        content: "",
        startLine: 1,
        endLine: 0,
        totalLines: 0,
        truncated: false,
      });
    });
    const captured = capture();
    const { agent } = workspaceAgent(environment, [
      { id: "call-1", tool: "read", input: { path: "a" } },
    ]);
    expect(
      (await agent.run({}, undefined, { ...captured.context, signal: controller.signal })).status
    ).toBe("cancelled");
    expect(captured.messages).toEqual(['Read "a"', 'Read "a": cancelled']);
  });

  it("bounds and escapes command previews while preserving nonzero exit and timeout details", async () => {
    const environment = remote();
    vi.mocked(environment.bash).mockReturnValue({
      cwd: "/remote/project",
      stdout: "PRIVATE OUTPUT",
      stderr: "PRIVATE ERROR",
      exitCode: 7,
      signal: null,
      timedOut: true,
      truncated: true,
    });
    const captured = capture();
    const command = `printf '\u001b[2J\u009b31m'\n${"x".repeat(500)} END-OF-LONG-COMMAND`;
    const { agent } = workspaceAgent(environment, [
      { id: "call-1", tool: "bash", input: { command } },
    ]);
    await agent.runOrThrow({}, undefined, captured.context);
    const text = captured.messages.join("\n");
    expect(text).toContain("…");
    expect(text).toContain("exit 7, timed out, output truncated");
    expect(text).not.toContain("\u001b");
    expect(text).not.toContain("\u009b");
    expect(text).not.toContain("END-OF-LONG-COMMAND");
    expect(text).not.toContain("PRIVATE");
    expect(captured.messages.every((message) => message.length < 250)).toBe(true);
  });

  it("preserves significant whitespace in path previews while keeping each log on one line", async () => {
    const environment = remote();
    const captured = capture();
    const path = "  file\nname  ";
    const { agent } = workspaceAgent(environment, [
      { id: "call-1", tool: "read", input: { path } },
    ]);
    await agent.runOrThrow({}, undefined, captured.context);
    expect(captured.messages[0]).toBe('Read "  file\\nname  "');
    expect(captured.messages.every((message) => !message.includes("\n"))).toBe(true);
    expect(environment.read).toHaveBeenCalledWith(
      expect.objectContaining({ path }),
      expect.anything()
    );
  });

  it("does not publish an action for an invalid batch or a skipped dry-run write", async () => {
    const invalid = capture();
    const invalidAgent = workspaceAgent(remote(), [
      { id: "write", tool: "write", input: { path: "untouched", content: "x" } },
      { id: "read", tool: "read", input: { path: "a", startLine: 0 } },
    ]).agent;
    expect((await invalidAgent.run({}, undefined, invalid.context)).status).toBe("failed");
    expect(invalid.messages).toEqual([]);
    const preview = capture();
    const environment = remote();
    const { agent } = workspaceAgent(environment, [
      { id: "write", tool: "write", input: { path: "untouched", content: "x" } },
    ]);
    await agent.run({}, { dryRun: true }, preview.context);
    expect(preview.messages).toEqual([]);
    expect(environment.write).not.toHaveBeenCalled();
  });
});
