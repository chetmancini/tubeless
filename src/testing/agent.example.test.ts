import { DelegatingAgent } from "../../examples/agent-delegation.js";
import { describe, expect, expectTypeOf, it } from "vitest";
import { ScriptedAgent, runAgentExample } from "../../examples/agent.js";

describe("public agent recipe", () => {
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
