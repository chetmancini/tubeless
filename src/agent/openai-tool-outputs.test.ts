import { expect, it } from "vitest";
import { openaiToolOutputs } from "./openai-tool-outputs.js";

it("keeps a complete batch unchanged when it fits, including recoverable errors", () => {
  const outcomes = [
    { id: "read", tool: "read", ok: true as const, value: { content: "exact text" } },
    {
      id: "missing",
      tool: "read",
      ok: false as const,
      error: { code: "ENOENT", message: "Missing" },
    },
  ];
  const outputs = openaiToolOutputs(outcomes, 1_000_000);
  expect(outputs.map((item) => [item.call_id, JSON.parse(item.output)])).toEqual([
    ["read", { ok: true, value: { content: "exact text" } }],
    ["missing", { ok: false, error: { code: "ENOENT", message: "Missing" } }],
  ]);
});

it.each([1200, 1_000_000])(
  "bounds encoded output bytes with escaped Unicode and errors (budget %i)",
  (budget) => {
    const value = '🙂"\\\t\u0001'.repeat(30_000);
    const outcomes = [
      { id: "large", tool: "read", ok: true as const, value },
      {
        id: "error",
        tool: "custom",
        ok: false as const,
        error: { code: "FAILED", message: value },
      },
      { id: "small", tool: "write", ok: true as const, value: "done" },
    ];
    const outputs = openaiToolOutputs(outcomes, budget);
    const history = [{ role: "user", content: "Task" }];
    const addedBytes =
      Buffer.byteLength(JSON.stringify([...history, ...outputs])) -
      Buffer.byteLength(JSON.stringify(history));
    expect(addedBytes).toBeLessThanOrEqual(Math.min(budget, 262_144));
    expect(outputs.map((item) => item.call_id)).toEqual(["large", "error", "small"]);
    for (const index of [0, 1]) {
      const output = JSON.parse(outputs[index]!.output);
      const outcome = outcomes[index]!;
      const original = JSON.stringify(
        outcome.ok ? { ok: true, value: outcome.value } : { ok: false, error: outcome.error }
      );
      expect(output).toMatchObject({
        ok: outcome.ok,
        truncated: true,
        originalBytes: Buffer.byteLength(original),
      });
      expect(original.startsWith(output.preview)).toBe(true);
      expect(output.preview).not.toContain("\uFFFD");
      expect(output.notice).toContain("do not repeat successful mutations");
    }
    expect(JSON.parse(outputs[2]!.output)).toEqual({ ok: true, value: "done" });
    expect(outcomes[0]!.value).toBe(value);
  }
);

it("fails explicitly when even one result marker cannot fit", () => {
  expect(() =>
    openaiToolOutputs([{ id: "read", tool: "read", ok: true, value: "text" }], 1)
  ).toThrow("no room for tool output metadata");
});

it.each([false, true])(
  "reserves unequal call-ID overhead before sharing preview space (small result: %s)",
  (smallResult) => {
    const outcomes = [
      { id: "long".repeat(64), tool: "read", ok: true as const, value: "x".repeat(300_000) },
      {
        id: "s",
        tool: "read",
        ok: true as const,
        value: smallResult ? "done" : "y".repeat(300_000),
      },
    ];
    const minimum = openaiToolOutputs(outcomes, 1_000_000).map((item) => {
      const output = JSON.parse(item.output);
      return output.truncated
        ? { ...item, output: JSON.stringify({ ...output, preview: "" }) }
        : item;
    });
    const history = [{ role: "user", content: "Task" }];
    const budget =
      Buffer.byteLength(JSON.stringify([...history, ...minimum])) -
      Buffer.byteLength(JSON.stringify(history));
    expect(openaiToolOutputs(outcomes, budget)).toEqual(minimum);
    expect(() => openaiToolOutputs(outcomes, budget - 1)).toThrow(
      "no room for tool output metadata"
    );
  }
);
