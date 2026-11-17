import { describe, expect, it } from "vitest";
import { defineAgentLoop, defineTool } from "../agent/agent.js";
import { emptyInput, numberSchema } from "../agent/agent.test-support.js";
import { transcriptRecord } from "../tracing/agent-transcript.test-support.js";
import { createAgentTranscriptCollector } from "./testing.js";

describe("agent transcript evaluation", () => {
  it("captures a scripted agent's validated calls, outcomes and terminal evidence", async () => {
    const transcript = createAgentTranscriptCollector();
    const tool = defineTool({
      description: "Double",
      inputSchema: numberSchema,
      outputSchema: numberSchema,
      run: (value) => value * 2,
    });
    const run = await defineAgentLoop({
      id: "evaluated",
      inputSchema: emptyInput,
      resultSchema: numberSchema,
      defaultTools: [],
      tools: { double: tool },
      transcript,
      initialState: () => 0,
      decide: (state, context) =>
        context.turn === 1
          ? { kind: "continue", calls: [{ id: "one", tool: "double", input: 2 }] }
          : { kind: "finish", result: state },
      reduce: (_state, outcomes) => (outcomes[0].ok ? outcomes[0].value : 0),
    }).run();
    expect(run.value).toBe(4);
    expect(() => transcript.assertComplete(run.runId)).not.toThrow();
    expect(transcript.records).toContainEqual(
      expect.objectContaining({ event: { kind: "call", id: "one", tool: "double", input: 2 } })
    );
    expect(transcript.records).toContainEqual(
      expect.objectContaining({
        event: { kind: "outcome", outcome: { id: "one", tool: "double", ok: true, value: 4 } },
      })
    );
  });

  it("owns immutable snapshots and checks each run independently", () => {
    const collector = createAgentTranscriptCollector();
    const input = { n: 2 };
    collector.write(transcriptRecord(1, { kind: "call", id: "one", tool: "tool", input }));
    const early = collector.records;
    input.n = 3;
    collector.write(transcriptRecord(2, { kind: "end", status: "failed" }));
    collector.write(transcriptRecord(1, { kind: "assistant", text: "pending" }, "other"));
    expect(early).toHaveLength(1);
    expect(Object.isFrozen(early)).toBe(true);
    expect(early[0]).toMatchObject({ event: { input: { n: 2 } } });
    expect(() => collector.assertComplete("agent:one")).not.toThrow();
    expect(() => collector.assertComplete()).toThrow("terminal");
    expect(() => collector.assertComplete("missing")).toThrow("No transcript");
  });

  it("refuses empty, omitted, limited, gapped, conflicting and post-terminal evidence", () => {
    const { event: _, ...base } = transcriptRecord(1);
    for (const records of [
      [],
      [{ ...base, omitted: "decision", reason: "record-limit" }],
      [{ ...base, limit: "maxBytes" }],
      [transcriptRecord(2, { kind: "end", status: "completed" })],
      [
        transcriptRecord(),
        { ...transcriptRecord(2, { kind: "end", status: "completed" }), agentId: "different" },
      ],
      [transcriptRecord(1, { kind: "end", status: "completed" }), transcriptRecord(2)],
    ] as const) {
      const collector = createAgentTranscriptCollector();
      records.forEach((record) => collector.write(record));
      expect(() => collector.assertComplete()).toThrow();
    }
  });

  it("retains earlier evidence and cannot certify completeness after hitting its own byte cap", () => {
    const record = transcriptRecord();
    const bytes = new TextEncoder().encode(JSON.stringify(record)).length + 1;
    const collector = createAgentTranscriptCollector({ maxBytes: bytes });
    collector.write(record);
    expect(() =>
      collector.write(transcriptRecord(2, { kind: "end", status: "completed" }))
    ).toThrow("byte limit");
    expect(collector.records).toHaveLength(1);
    expect(() => collector.assertComplete()).toThrow("incomplete");
    expect(() => createAgentTranscriptCollector({ maxBytes: Infinity })).toThrow(RangeError);
  });
});
