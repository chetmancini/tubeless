import {
  createSteps,
  definePipeline,
  type PipelineContext,
  type PipelineStepContext,
  type Step,
} from "../core/pipeline.js";
import type { NodeCheckCommand, NodeCheckPlan } from "../utilities/node-check-plan.js";
import { vitestCheckReport } from "../node/vitest-report.js";
import { prepareCheckReport, readCheckReportFile } from "../node/check-files.js";
import type { CheckProcessOutcome } from "../utilities/check-report.js";
import type { NodeCheckExecution } from "./node-check.js";

type CommandRunner = (
  command: NodeCheckCommand,
  context: Pick<PipelineStepContext<object>, "cwd" | "signal" | "log">
) => Promise<CheckProcessOutcome>;

const PIPELINE_ID = "node-check";

/** Schedule an already verified plan, with process admission owned by the caller. */
export async function executeNodeCheckPlan(
  plan: NodeCheckPlan,
  context: Partial<PipelineContext> & { cwd: string },
  run: CommandRunner,
  dryRun?: boolean
): Promise<NodeCheckExecution> {
  const { step } = createSteps();
  const steps = new Map<string, Step<string, CheckProcessOutcome, object>>();
  const commands: NodeCheckExecution["commands"] = [];
  const reports: NodeCheckExecution["reports"] = [];
  for (const command of plan.commands) {
    const report:
      | { toolVersion: string; entry: NodeCheckExecution["reports"][number] }
      | undefined =
      command.kind === "vitest"
        ? {
            toolVersion: command.report.version,
            entry: {
              stepId: command.id,
              path: command.report.path,
              result: { state: "missing" },
            },
          }
        : undefined;
    if (report) reports.push(report.entry);
    const dependsOn = command.dependsOn.map((id) => {
      const dependency = steps.get(id);
      if (!dependency) throw new Error(`Check dependency ${id} must precede ${command.id}.`);
      return dependency;
    });
    steps.set(
      command.id,
      step(command.id, {
        description: command.reason,
        dependsOn,
        dryRun: "skip",
        run: async (_inputs, ctx) => {
          if (report) await prepareCheckReport(ctx.cwd, report.entry.path);
          const outcome = await run(command, ctx);
          commands.push({ id: command.id, process: outcome });
          if (report) {
            const file = await readCheckReportFile(ctx.cwd, report.entry.path);
            report.entry.result =
              "result" in file
                ? file.result
                : vitestCheckReport(file.content, {
                    root: ctx.cwd,
                    toolVersion: report.toolVersion,
                    context: {
                      pipelineId: PIPELINE_ID,
                      runId: ctx.runId,
                      stepId: command.id,
                      attemptId: ctx.attemptId,
                    },
                    process: outcome,
                  });
          }
          ctx.signal?.throwIfAborted();
          if (outcome.status !== "exited" || outcome.exitCode !== 0)
            throw Object.assign(
              new Error(
                `Native command ${command.id}: ${outcome.status} (${outcome.exitCode ?? outcome.signal ?? "unknown"}).`
              ),
              { code: "NATIVE_PROCESS_FAILED" }
            );
          const collected = report?.entry.result;
          if (
            collected &&
            (collected.state !== "available" ||
              collected.report.completeness !== "complete" ||
              collected.report.tests.some((test) => test.outcome === "failed") ||
              collected.report.failures.length)
          )
            throw new Error(
              `Expected complete Vitest report for ${command.id}; collection cannot establish a complete gate.`
            );
          return outcome;
        },
      })
    );
  }
  const pipeline = definePipeline({ id: PIPELINE_ID, steps: [...steps.values()] });
  const execution = await pipeline.run(
    {},
    { maxConcurrency: plan.maxConcurrency, dryRun },
    context
  );
  return { version: 1, run: execution, commands, reports };
}
