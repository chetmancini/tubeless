import { describe, expect, it } from "vitest";
import { agentTranscriptPageSchema, decodeAgentTranscriptRecord } from "./agent-transcript.js";
import { transcriptRecord } from "./agent-transcript.test-support.js";

describe("transcript ingestion", () => {
  it("preserves JSON content without invoking accessors and owns its snapshot", () => {
    const source = transcriptRecord(1, { kind: "decision", decision: { nested: [1, "hello"] } });
    const decoded = decodeAgentTranscriptRecord(source);
    expect(decoded).toEqual(source);
    expect(decoded).not.toBe(source);
    expect(Object.isFrozen(decoded)).toBe(true);
    expect(Object.isFrozen("event" in decoded && decoded.event)).toBe(true);
    expect(() =>
      decodeAgentTranscriptRecord({
        get event() {
          throw new Error("private");
        },
      })
    ).toThrow("unsupported-content");
  });

  it.each([
    { version: 2 },
    { sequence: 0 },
    { sequence: 1.5 },
    { timestamp: Infinity },
    { turn: -1 },
    { event: { kind: "constructor" } },
    { event: { kind: "assistant", text: 42 } },
    { event: { kind: "call", id: "x", tool: "tool" } },
    { event: { kind: "end", status: "completed" }, turn: 1 },
    { turn: 0 },
    { limit: "maxBytes" },
  ])("rejects invalid records: %j", (change) => {
    expect(() => decodeAgentTranscriptRecord({ ...transcriptRecord(), ...change })).toThrow();
  });

  it("accepts explicit omission and limit markers and bounds encoded UTF-8", () => {
    const { event: _, ...base } = transcriptRecord();
    expect(
      decodeAgentTranscriptRecord({ ...base, omitted: "outcome", reason: "unsupported-content" })
    ).toMatchObject({ omitted: "outcome" });
    expect(decodeAgentTranscriptRecord({ ...base, limit: "maxBytes" })).toMatchObject({
      limit: "maxBytes",
    });
    expect(() =>
      decodeAgentTranscriptRecord(
        transcriptRecord(1, { kind: "assistant", text: "🙂".repeat(17_000) })
      )
    ).toThrow();
    expect(() =>
      decodeAgentTranscriptRecord({ ...base, omitted: "prompt", reason: "unknown" })
    ).toThrow();
  });

  it("rejects pages with mixed run identities, nonadvancing cursors or excessive records", () => {
    const page = { runId: "agent:one", records: [transcriptRecord()], status: "partial" };
    expect(agentTranscriptPageSchema.decode(page, "page")).toEqual(page);
    expect(() => agentTranscriptPageSchema.decode({ ...page, runId: "other" }, "page")).toThrow();
    expect(() => agentTranscriptPageSchema.decode({ ...page, nextSequence: 2 }, "page")).toThrow();
    expect(() =>
      agentTranscriptPageSchema.decode(
        { ...page, records: [transcriptRecord(2), transcriptRecord(1)] },
        "page"
      )
    ).toThrow();
    expect(() =>
      agentTranscriptPageSchema.decode(
        { ...page, records: Array.from({ length: 51 }, (_, index) => transcriptRecord(index + 1)) },
        "page"
      )
    ).toThrow();
  });
});
