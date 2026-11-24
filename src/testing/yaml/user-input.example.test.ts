import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

function review(replies: unknown[], options: { dryRun?: boolean; abortAt?: number } = {}) {
  const result = spawnSync(
    "bun",
    [
      "-e",
      `
      import { createDeclarativeReviewPipeline } from "./examples/yaml-user-input.ts";
      const replies = ${JSON.stringify(replies)};
      const options = ${JSON.stringify(options)};
      const controller = new AbortController();
      const requests = [];
      const progress = [];
      const signals = [];
      const pipeline = createDeclarativeReviewPipeline(async (request, signal) => {
        requests.push(request);
        signals.push(signal === controller.signal);
        if (requests.length === options.abortAt) {
          controller.abort();
          return new Promise(() => {});
        }
        return replies.shift();
      });
      const run = await pipeline.run(undefined, { dryRun: options.dryRun }, {
        signal: controller.signal,
        hooks: { onStepProgress: ({ progress: event }) => progress.push(event.message) },
      });
      console.log(JSON.stringify({
        status: run.status,
        value: run.value,
        steps: run.steps.map(({ id, status }) => ({ id, status })),
        errors: run.errors.map(({ message }) => message),
        requests, progress, signals,
      }));
      `,
    ],
    { encoding: "utf8", timeout: 5_000 }
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).toBe("");
  return JSON.parse(result.stdout) as {
    status: string;
    value: { approved: boolean | null; result: unknown };
    steps: { id: string; status: string }[];
    errors: string[];
    requests: { kind: string; message: string; choices?: { value: string; label: string }[] }[];
    progress: string[];
    signals: boolean[];
  };
}

describe("public YAML user-input recipe", () => {
  it("asks for choices, normalizes text, and confirms the upstream output before proceeding", () => {
    const result = review(["b", "  please revise  ", true]);
    expect(result.status).toBe("completed");
    expect(result.value).toEqual({
      approved: true,
      result: { output: "xyz", decision: "b", note: "please revise" },
    });
    expect(result.requests.map(({ kind }) => kind)).toEqual(["choice", "text", "confirm"]);
    expect(result.requests[0]?.choices?.map(({ value }) => value)).toEqual(["a", "b", "c"]);
    expect(result.requests[2]?.message).toBe("Output was xyz. Confirm proceeding?");
    expect(result.progress.filter((message) => message === "Waiting for input")).toHaveLength(3);
    expect(result.signals).toEqual([true, true, true]);
  });

  it("treats a declined confirmation as a successful skip", () => {
    const result = review(["a", "keep the output", false]);
    expect(result.status).toBe("completed");
    expect(result.value).toEqual({ approved: false, result: null });
    expect(result.steps).toContainEqual({ id: "proceed", status: "skipped" });
    expect(result.errors).toEqual([]);
  });

  it.each([
    { replies: ["d"], count: 1, error: "Choose a, b, or c" },
    { replies: ["a", "  "], count: 2, error: "Enter a non-empty note" },
    { replies: ["c", "reviewed", "yes"], count: 3, error: "Expected a boolean confirmation" },
  ])("rejects invalid input: $error", ({ replies, count, error }) => {
    const result = review(replies);
    expect(result.status).toBe("failed");
    expect(result.requests).toHaveLength(count);
    expect(result.errors.join("\n")).toContain(error);
    expect(result.steps).toContainEqual({ id: "proceed", status: "skipped" });
  });

  it("does not prompt in a dry run and distinguishes no answer from a decline", () => {
    const result = review([], { dryRun: true });
    expect(result.status).toBe("completed");
    expect(result.requests).toEqual([]);
    expect(result.value).toEqual({ approved: null, result: null });
    expect(result.steps).toContainEqual({ id: "proceed", status: "skipped" });
  });

  it("cancels a pending registered input handler without starting the next question", () => {
    const result = review(["a"], { abortAt: 2 });
    expect(result.status).toBe("cancelled");
    expect(result.requests.map(({ kind }) => kind)).toEqual(["choice", "text"]);
    expect(result.steps).toContainEqual({ id: "note", status: "cancelled" });
    expect(result.steps).toContainEqual({ id: "proceed", status: "cancelled" });
  });
});
