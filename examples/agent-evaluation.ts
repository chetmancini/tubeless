import assert from "node:assert/strict";
import { defineAgent } from "tubeless/agent";
import { createAgentTestWorkspace, createAgentTranscriptCollector } from "tubeless/testing";

/** Evaluate a real read tool with a scripted model, owned fixtures and no provider credentials. */
export async function runAgentEvaluationExample() {
  const workspace = await createAgentTestWorkspace({ "sample.txt": "hello\n" });
  const transcript = createAgentTranscriptCollector();
  try {
    const agent = defineAgent({
      id: "evaluate-read",
      projectContext: false,
      defaultTools: ["read"],
      transcript,
      model: (_request, context) => ({
        conversation: null,
        decision:
          context.turn === 1
            ? {
                kind: "continue",
                calls: [{ id: "read-sample", tool: "read", input: { path: "sample.txt" } }],
              }
            : { kind: "finish", result: { answer: "Read the fixture." } },
      }),
    });
    const result = await agent.runOrThrow(
      { task: "Read sample.txt. Leave all files unchanged." },
      undefined,
      { cwd: workspace.cwd }
    );
    transcript.assertComplete();
    await workspace.assertUnchanged();
    const outcome = transcript.records.find(
      (record) => "event" in record && record.event.kind === "outcome"
    );
    assert(
      outcome && "event" in outcome && outcome.event.kind === "outcome" && outcome.event.outcome.ok
    );
    const value = outcome.event.outcome.value;
    assert(value && typeof value === "object" && "content" in value);
    assert.equal(value.content, "hello\n");
    return { result, records: transcript.records };
  } finally {
    await workspace.close();
  }
}
