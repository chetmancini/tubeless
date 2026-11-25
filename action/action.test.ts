import { describe, expect, it } from "vitest";
import { executeAction, type ActionHost } from "./action.js";
import {
  CLOUD_DISPATCH_UNAVAILABLE,
  stickyMarker,
  type ActionRequest,
  type CommandResult,
} from "./report.js";

function result(stdout: string, exitCode = 0): CommandResult {
  return { stdout, stderr: "", exitCode };
}

function host(run: ActionHost["run"]): {
  host: ActionHost;
  summary: string[];
  comments: string[];
  outputs: { plan: string; mermaid: string }[];
  logs: string[];
} {
  const summary: string[] = [];
  const comments: string[] = [];
  const outputs: { plan: string; mermaid: string }[] = [];
  const logs: string[] = [];
  return {
    host: {
      run,
      writeSummary(markdown) {
        summary.push(markdown);
      },
      writeOutputs(value) {
        outputs.push(value);
      },
      async comment(body) {
        comments.push(body);
      },
      log(line) {
        logs.push(line);
      },
    },
    summary,
    comments,
    outputs,
    logs,
  };
}

const planRequest: ActionRequest = {
  pipeline: "examples/typed-import.ts",
  mode: "plan",
  comment: true,
  summary: true,
  cloudToken: "",
  pullRequest: 8,
};

describe("action execution", () => {
  it("plans and graphs without running the pipeline", async () => {
    const calls: string[][] = [];
    const harness = host((args) => {
      calls.push([...args]);
      if (args[0] === "graph") return result("flowchart TD\n  load");
      return result("import plan");
    });

    const code = await executeAction(planRequest, harness.host);

    expect(code).toBe(0);
    expect(calls).toEqual([
      ["plan", "examples/typed-import.ts"],
      ["graph", "examples/typed-import.ts"],
    ]);
    expect(harness.outputs).toEqual([{ plan: "import plan", mermaid: "flowchart TD\n  load" }]);
    expect(harness.summary).toHaveLength(1);
    expect(harness.comments).toEqual(harness.summary);
    expect(harness.comments[0]).toContain(stickyMarker(planRequest.pipeline));
    expect(harness.comments[0]).toContain("```mermaid");
    expect(harness.logs.some((line) => line.includes("tubeless run"))).toBe(false);
  });

  it("skips the sticky comment when there is no pull request", async () => {
    const harness = host(() => result("ok"));
    const code = await executeAction(
      { ...planRequest, pullRequest: undefined, summary: false },
      harness.host
    );
    expect(code).toBe(0);
    expect(harness.comments).toEqual([]);
    expect(harness.summary).toEqual([]);
    expect(harness.logs).toContain("No pull request; skipped the sticky comment.");
  });

  it("dry-runs through the CLI and returns its exit code", async () => {
    const calls: string[][] = [];
    const harness = host((args) => {
      calls.push([...args]);
      if (args[0] === "run") return result("failed", 6);
      return result("ok");
    });
    const code = await executeAction(
      { ...planRequest, mode: "dry-run", comment: false, summary: false },
      harness.host
    );
    expect(calls.map((args) => args[0])).toEqual(["plan", "graph", "run"]);
    expect(calls[0]).toEqual(["plan", "--dry-run", planRequest.pipeline]);
    expect(calls[2]).toEqual(["run", planRequest.pipeline, "--", "--dry-run"]);
    expect(code).toBe(6);
    expect(harness.comments).toEqual([]);
  });

  it("does not run locally when cloud dispatch is still unavailable", async () => {
    const calls: string[][] = [];
    const harness = host((args) => {
      calls.push([...args]);
      return result(args[0] === "graph" ? "flowchart TD" : "plan");
    });
    const code = await executeAction(
      { ...planRequest, mode: "run", cloudToken: "secret-token", comment: false },
      harness.host
    );
    expect(code).toBe(1);
    expect(calls.map((args) => args[0])).toEqual(["plan", "graph"]);
    expect(harness.summary[0]).toContain(CLOUD_DISPATCH_UNAVAILABLE);
    expect(harness.summary[0]).not.toContain("secret-token");
  });

  it("requires a pipeline", async () => {
    const harness = host(() => result("unused"));
    await expect(executeAction({ ...planRequest, pipeline: "" }, harness.host)).rejects.toThrow(
      /pipeline is required/
    );
  });
});
