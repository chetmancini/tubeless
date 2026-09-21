import { createSteps, definePipeline, requireOutputs } from "tubeless";
import { definePipelineCommand } from "tubeless/cli";
import { defineProject } from "tubeless/project";
import { runPipelineCommand } from "./scripts/run-pipeline-command.ts";

const { step } = createSteps();

function checkStep<const TId extends string>(id: TId, description: string, script: string) {
  return step(id, {
    description,
    run: async (_inputs, context) => {
      await runPipelineCommand("bun", ["run", script], context);
      return { script };
    },
  });
}

const lint = checkStep("lint", "Lint package sources.", "lint:run");
const knip = checkStep("knip", "Reject unused files, dependencies, and exports.", "knip");
const format = checkStep("format", "Verify repository formatting.", "format:check");
const typecheck = checkStep(
  "typecheck",
  "Type-check the package, examples, and automation.",
  "typecheck:run"
);
const docs = checkStep("docs", "Validate the documentation learning surface.", "docs:check");
const api = checkStep("api", "Verify the generated public API reference.", "api:check");
const studio = checkStep("studio", "Verify the generated Studio client.", "studio:check");
const test = checkStep("test", "Run the package test suite.", "test:run");
const pack = checkStep("pack", "Smoke-test the publishable package artifact.", "pack:verify");

const checks = [lint, knip, format, typecheck, docs, api, studio, test, pack] as const;
const qualityGate = step("quality-gate", {
  dependsOn: checks,
  description: "Require every package verification step to succeed.",
  run: () => ({ checks: checks.length }),
});

export const CheckPipeline = definePipeline({
  id: "check",
  name: "Repository checks",
  description: "Run the complete Tubeless package quality gate.",
  steps: [...checks, qualityGate],
  targets: [qualityGate],
  finalize: requireOutputs([qualityGate], (outputs) => outputs["quality-gate"]),
});

const CheckCommand = definePipelineCommand(CheckPipeline, {
  summarize: ({ checks }) => [`Passed ${checks} repository checks.`],
});

export default defineProject("tubeless", [CheckPipeline], {
  name: "Tubeless",
  description: "Repository automation powered by Tubeless itself.",
  commands: [CheckCommand],
});
