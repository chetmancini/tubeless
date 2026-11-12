import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const workflowPath = join(root, ".github/workflows/api-label.yml");

interface WorkflowStep {
  uses?: string;
  run?: string;
}
interface WorkflowJob {
  permissions?: Record<string, string>;
  steps: WorkflowStep[];
}
interface Workflow {
  on?: Record<string, unknown>;
  true?: Record<string, unknown>;
  permissions?: Record<string, string>;
  jobs: Record<string, WorkflowJob>;
}

const workflow = JSON.parse(
  execFileSync(
    "bun",
    [
      "-e",
      "console.log(JSON.stringify(Bun.YAML.parse(await Bun.file(Bun.argv.at(-1)).text())))",
      workflowPath,
    ],
    { encoding: "utf8" }
  )
) as Workflow;

// Bun's YAML parser may read the key `on` as the boolean `true`.
const trigger = workflow.on ?? workflow.true ?? {};
const steps = Object.values(workflow.jobs).flatMap((job) => job.steps);

describe("api-label workflow", () => {
  it("triggers only on pull_request", () => {
    expect(Object.keys(trigger)).toEqual(["pull_request"]);
  });

  it("grants the labelling job only the write permission it needs", () => {
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(workflow.jobs["label-breaking"]?.permissions).toEqual({
      contents: "read",
      "pull-requests": "write",
    });
  });

  it("pins every action by commit", () => {
    const uses = steps.flatMap((step) => (step.uses ? [step.uses] : []));
    expect(uses.length).toBeGreaterThan(0);
    for (const action of uses) expect(action).toMatch(/@[0-9a-f]{40}$/);
  });

  it("runs no dependency code and no interpolated event data", () => {
    const runs = steps.flatMap((step) => (step.run ? [step.run] : []));
    expect(runs.length).toBeGreaterThan(0);
    for (const run of runs) {
      for (const forbidden of ["${{", "bun ci", "bun install", "npm install", "make "]) {
        expect(run).not.toContain(forbidden);
      }
    }
  });
});
