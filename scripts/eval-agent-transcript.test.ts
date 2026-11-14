import { expect, it } from "vitest";
import { transcriptRecord } from "../src/tracing/agent-transcript.test-support.js";
import type { AgentTranscriptEvent } from "../src/tracing/agent-transcript.js";
import { projectEvaluationTranscript } from "./eval-agent-transcript.mjs";

it("keeps proposal batches compatible while joining actual inputs and outcomes by turn", () => {
  let sequence = 0;
  const record = (turn: number, event: AgentTranscriptEvent) => ({
    ...transcriptRecord(++sequence, event),
    turn,
  });
  const first = {
    kind: "continue",
    calls: [
      { id: "same", tool: "tool", input: "2" },
      { id: "other", tool: "tool", input: "4" },
    ],
  };
  const second = { kind: "continue", calls: [{ id: "same", tool: "tool", input: "3" }] };
  const output = projectEvaluationTranscript([
    record(1, { kind: "decision", decision: first }),
    record(1, { kind: "call", id: "same", tool: "tool", input: 2 }),
    record(1, { kind: "call", id: "other", tool: "tool", input: 4 }),
    record(1, { kind: "outcome", outcome: { id: "other", tool: "tool", ok: true, value: 8 } }),
    record(1, { kind: "outcome", outcome: { id: "same", tool: "tool", ok: true, value: 4 } }),
    record(2, { kind: "decision", decision: second }),
    record(2, { kind: "call", id: "same", tool: "tool", input: 3 }),
    record(2, { kind: "outcome", outcome: { id: "same", tool: "tool", ok: true, value: 6 } }),
    record(3, { kind: "compaction", provider: "anthropic" }),
    record(3, { kind: "decision", decision: { kind: "finish", result: { answer: "done" } } }),
  ]);
  expect(output.calls).toEqual([...first.calls, ...second.calls]);
  expect(output.turns.map((turn) => turn.outcomes.map((outcome) => outcome.value))).toEqual([
    [],
    [4, 8],
    [6],
  ]);
  expect(output.toolLog).toEqual([
    { tool: "tool", input: 4, ok: true, value: 8 },
    { tool: "tool", input: 2, ok: true, value: 4 },
    { tool: "tool", input: 3, ok: true, value: 6 },
  ]);
  expect(output.compactions).toBe(1);
});
