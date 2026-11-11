import { expect, it, vi } from "vitest";
import { modelRequestReporter } from "./provider-usage.js";

it("records OpenAI reads, writes by lifetime, reasoning and request order without response content", async () => {
  const reportAttempt = vi.fn();
  const report = modelRequestReporter("openai", "fixture", { turn: 2, reportAttempt });
  const response = {
    output: "PRIVATE OUTPUT",
    usage: {
      input_tokens: 12000,
      output_tokens: 800,
      input_tokens_details: {
        cached_tokens: 4000,
        cache_write_tokens: 7000,
        cache_write_tokens_details: { ttl_30m_tokens: 3000, ttl_12h_tokens: 4000 },
      },
      output_tokens_details: { reasoning_tokens: 600 },
      private: "PRIVATE USAGE",
    },
  };
  expect(await report("compaction", async () => response)).toBe(response);
  await report("decision", async () => ({ usage: { input_tokens: 100, output_tokens: 0 } }));
  expect(reportAttempt.mock.calls[0]).toEqual([
    1,
    expect.objectContaining({
      "agent.model.provider": "openai",
      "agent.model.name": "fixture",
      "agent.model.operation": "compaction",
      "agent.model.request": 1,
      "agent.model.responseReceived": true,
      "agent.model.inputTokens": 12000,
      "agent.model.outputTokens": 800,
      "agent.model.cacheReadTokens": 4000,
      "agent.model.cacheWriteTokens": 7000,
      "agent.model.cacheWrite30mTokens": 3000,
      "agent.model.cacheWrite12hTokens": 4000,
      "agent.model.reasoningTokens": 600,
      "agent.model.durationMs": expect.any(Number),
      "agent.turn": 2,
    }),
  ]);
  expect(reportAttempt.mock.calls[1]![1]).toMatchObject({
    "agent.model.operation": "decision",
    "agent.model.request": 2,
    "agent.model.outputTokens": 0,
  });
  expect(JSON.stringify(reportAttempt.mock.calls)).not.toContain("PRIVATE");
});

it("includes Anthropic cached input in totals and counts compaction iteration usage once", async () => {
  const reportAttempt = vi.fn();
  const report = modelRequestReporter("anthropic", "fixture", { turn: 1, reportAttempt });
  const usage = {
    input_tokens: 100,
    output_tokens: 20,
    cache_read_input_tokens: 200,
    cache_creation_input_tokens: 300,
    cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 200 },
  };
  await report("decision", async () => ({ usage }));
  await report("compaction", async () => ({
    usage: { input_tokens: 0, output_tokens: 0, iterations: [{ type: "compaction", ...usage }] },
  }));
  for (const [, attributes] of reportAttempt.mock.calls)
    expect(attributes).toMatchObject({
      "agent.model.inputTokens": 600,
      "agent.model.uncachedInputTokens": 100,
      "agent.model.outputTokens": 20,
      "agent.model.cacheReadTokens": 200,
      "agent.model.cacheWriteTokens": 300,
      "agent.model.cacheWrite5mTokens": 100,
      "agent.model.cacheWrite1hTokens": 200,
    });
});

it("keeps unavailable or invalid counters unknown and records failed requests without leaking errors", async () => {
  const reportAttempt = vi.fn();
  const report = modelRequestReporter("openai", "fixture", { turn: 1, reportAttempt });
  await report("decision", async () => ({
    usage: {
      input_tokens: -1,
      output_tokens: "20",
      input_tokens_details: { cached_tokens: Number.POSITIVE_INFINITY, cache_write_tokens: 1.5 },
    },
  }));
  await report("decision", async () => ({}));
  const failure = new Error("PRIVATE ERROR");
  await expect(
    report("decision", async () => {
      throw failure;
    })
  ).rejects.toBe(failure);
  for (const [, attributes] of reportAttempt.mock.calls) {
    expect(attributes["agent.model.inputTokens"]).toBeUndefined();
    expect(attributes["agent.model.outputTokens"]).toBeUndefined();
    expect(attributes["agent.model.cacheReadTokens"]).toBeUndefined();
    expect(attributes["agent.model.cacheWriteTokens"]).toBeUndefined();
  }
  expect(reportAttempt.mock.calls[2]![1]).toMatchObject({
    "agent.model.request": 3,
    "agent.model.responseReceived": false,
  });
  expect(JSON.stringify(reportAttempt.mock.calls)).not.toContain("PRIVATE");
});
