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

/** Schedule an already verified plan, with process admission owned by the caller. */
export async function executeNodeCheckPlan(
  plan: NodeCheckPlan,
  context: Partial<PipelineContext> & { cwd: string },
  run: CommandRunner,
  dryRun?: boolean
): Promise<NodeCheckExecution> {
  const { step } = createSteps();
  const steps: Step<string, CheckProcessOutcome, object>[] = [];
  const commands: NodeCheckExecution["commands"] = [];
  const reports: NodeCheckExecution["reports"] = plan.commands
    .filter((command) => command.kind === "vitest")
    .map(({ id: stepId, report: { path } }) => ({ stepId, path, result: { state: "missing" } }));
  for (const command of plan.commands) {
    steps.push(
      step(command.id, {
        description: command.reason,
        dependsOn: command.dependsOn.map((id) => steps.find((item) => item.id === id)!),
        dryRun: "skip",
        run: async (_inputs, ctx) => {
          if (command.kind === "vitest") await prepareCheckReport(ctx.cwd, command.report.path);
          const outcome = await run(command, ctx);
          commands.push({ id: command.id, process: outcome });
          if (command.kind === "vitest") {
            const file = await readCheckReportFile(ctx.cwd, command.report.path);
            const result =
              "result" in file
                ? file.result
                : vitestCheckReport(file.content, {
                    root: ctx.cwd,
                    toolVersion: command.report.version,
                    context: {
                      pipelineId: "node-check",
                      runId: ctx.runId,
                      stepId: command.id,
                      attemptId: ctx.attemptId,
                    },
                    process: outcome,
                  });
            reports.find((report) => report.stepId === command.id)!.result = result;
            ctx.signal?.throwIfAborted();
            if (
              outcome.status === "exited" &&
              outcome.exitCode === 0 &&
              (result.state !== "available" ||
                result.report.completeness !== "complete" ||
                result.report.tests.some((test) => test.outcome === "failed") ||
                result.report.failures.length)
            )
              throw new Error(
                `Expected complete Vitest report for ${command.id}; collection cannot establish a complete gate.`
              );
          }
          ctx.signal?.throwIfAborted();
          if (outcome.status !== "exited" || outcome.exitCode !== 0)
            throw Object.assign(
              new Error(
                `Native command ${command.id}: ${outcome.status} (${outcome.exitCode ?? outcome.signal ?? "unknown"}).`
              ),
              { code: "NATIVE_PROCESS_FAILED" }
            );
          return outcome;
        },
      })
    );
  }
  const pipeline = definePipeline({ id: "node-check", steps });
  const execution = await pipeline.run(
    {},
    { maxConcurrency: plan.maxConcurrency, dryRun },
    context
  );
  return { version: 1, run: execution, commands, reports };
}
