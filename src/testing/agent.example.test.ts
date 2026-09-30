import { DelegatingAgent } from "../../examples/agent-delegation.js";
import { AgentPipeline } from "../../examples/agent-pipeline.js";
import { describe, expect, expectTypeOf, it } from "vitest";
import { ScriptedAgent, runAgentExample } from "../../examples/agent.js";
import { WorkspaceAgent } from "../../examples/agent-workspace.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("public agent recipe", () => {
  it("passes a child agent's validated answer to an ordinary dependent step, including previews", async () => {
    expectTypeOf(AgentPipeline.runOrThrow).returns.resolves.toEqualTypeOf<string>();
    for (const dryRun of [false, true]) {
      expect(await AgentPipeline.runOrThrow({ question: "red missing" }, { dryRun })).toBe(
        "Summary: 3 characters; RED | 7 characters; Observed NOT_FOUND: Word unavailable"
      );
    }
  });
  it("uses every default tool and a custom tool to modify and verify a real workspace", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tubeless-workspace-recipe-"));
    try {
      expect(await WorkspaceAgent.runOrThrow({ directory: "demo" }, undefined, { cwd })).toEqual({
        answer: "Verified: all six default tools and a custom tool",
      });
      expect(await readFile(join(cwd, "demo/message.txt"), "utf8")).toBe("hello agent\n");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
  it("delegates to child agents and a mapped ordinary pipeline, including previews", async () => {
    expectTypeOf(DelegatingAgent.runOrThrow).returns.resolves.toEqualTypeOf<{ answer: string }>();
    for (const dryRun of [false, true]) {
      expect(await DelegatingAgent.runOrThrow({ question: "red blue" }, { dryRun })).toEqual({
        answer: "Summary: 3 characters; RED | 4 characters; BLUE",
      });
      expect(await DelegatingAgent.runOrThrow({ question: "missing" }, { dryRun })).toEqual({
        answer: "Summary: 7 characters; Observed NOT_FOUND: Word unavailable",
      });
    }
  });
  it("executes dynamic heterogeneous calls through public package imports", async () => {
    expectTypeOf(ScriptedAgent.runOrThrow).returns.resolves.toEqualTypeOf<{ answer: string }>();
    expect(await runAgentExample()).toEqual({ answer: "14 characters; HELLO; TUBELESS" });
    expect(await ScriptedAgent.runOrThrow({ question: "missing word" })).toEqual({
      answer: "12 characters; Observed NOT_FOUND: Word unavailable; WORD",
    });
    expect(await ScriptedAgent.runOrThrow({ question: "preview" }, { dryRun: true })).toEqual({
      answer: "7 characters; PREVIEW",
    });
  });
});
