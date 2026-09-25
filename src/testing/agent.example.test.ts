import { describe, expect, expectTypeOf, it } from "vitest";
import { ScriptedAgent, runAgentExample } from "../../examples/agent.js";

describe("public agent recipe", () => {
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
