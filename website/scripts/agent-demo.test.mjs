import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (name) => readFileSync(new URL(`../public/${name}`, import.meta.url), "utf8");

test("the published evaluation has complete call/result evidence for every passing task", () => {
  const report = JSON.parse(read("agent-evaluation.json"));
  assert.ok(report.model && report.reasoningEffort && report.completedAt);
  assert.deepEqual(report.results.map((run) => run.id), [
    "investigate-edit-verify", "project-context", "nested-guidance", "recover-and-compact",
  ]);
  for (const run of report.results) {
    assert.equal(run.passed, true, run.id);
    assert.ok(run.verification && run.answer && run.task, run.id);
    assert.equal(run.turns.at(-1).decision.kind, "finish", run.id);
    for (const [index, turn] of run.turns.entries()) {
      if (turn.decision.kind !== "continue") continue;
      for (const call of turn.decision.calls) {
        assert.ok(run.turns[index + 1].outcomes.some((outcome) =>
          outcome.id === call.id && outcome.tool === call.tool), `${run.id}: ${call.id}`);
      }
    }
  }
});

test("the published evaluation matches the evaluator and model sources", () => {
  const { sourceHashes } = JSON.parse(read("agent-evaluation.json"));
  for (const path of ["src/agent/model-prompt.ts", "src/agent/openai.ts", "scripts/eval-agent.mjs"]) {
    const source = readFileSync(new URL(`../../${path}`, import.meta.url));
    assert.equal(sourceHashes[path], createHash("sha256").update(source).digest("hex"), path);
  }
});

test("the delegation recording connects real children and retains its recovered failure", () => {
  const { agents } = JSON.parse(read("agent-delegation.json"));
  const parent = agents.find((agent) => agent.pipelineId === "delegating-agent");
  assert.equal(agents.length, 3);
  for (const call of parent.turns[0].calls) {
    const child = agents.find((agent) => agent.runId === call.childAgentRunIds[0]);
    assert.equal(child.parentCall.agentRunId, parent.runId);
    assert.equal(child.parentCall.callId, call.callId);
    assert.equal(child.termination, "finish");
  }
  assert.ok(agents.some((agent) => agent.turns.some((turn) =>
    turn.calls.some((call) => call.error?.sourceCode === "NOT_FOUND"))));
});

test("public recordings omit workstation paths and provider credentials", () => {
  for (const name of ["agent-evaluation.json", "agent-delegation.json"]) {
    assert.doesNotMatch(read(name), /\/Users\/|\/private\/var\/|\/tmp\/tubeless-|sk-[a-zA-Z0-9_-]{20,}/);
  }
});
