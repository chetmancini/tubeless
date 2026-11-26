import { realpath } from "node:fs/promises";
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

type VitestCommand = Extract<NodeCheckCommand, { kind: "vitest" }>;
type ReportContext = Pick<PipelineStepContext<object>, "cwd" | "runId" | "attemptId">;

type FileCheckRunner = { stepId: string } & (
  | {
      mode: "inventory" | "files";
      run: (
        command: VitestCommand,
        context: PipelineStepContext<object>
      ) => Promise<{ process: CheckProcessOutcome; evidenceError?: string }>;
    }
  | {
      mode: "partitions";
      run: (command: VitestCommand, context: PipelineStepContext<object>) => Promise<void>;
    }
);

const PIPELINE_ID = "node-check";

export async function collectVitestReport(
  command: VitestCommand,
  context: ReportContext,
  process: CheckProcessOutcome,
  physicalRoot: boolean
): Promise<NodeCheckExecution["reports"][number]["result"]> {
  const file = await readCheckReportFile(context.cwd, command.report.path);
  if ("result" in file) return file.result;
  return vitestCheckReport(file.content, {
    root: physicalRoot ? await realpath(context.cwd) : context.cwd,
    toolVersion: command.report.version,
    context: {
      pipelineId: PIPELINE_ID,
      runId: context.runId,
      stepId: command.id,
      attemptId: context.attemptId,
    },
    process,
  });
}

export function requireCheckSuccess(
  label: string,
  outcome: CheckProcessOutcome,
  evidenceError?: string
): void {
  if (outcome.status !== "exited" || outcome.exitCode !== 0) {
    const message = `${label}: ${outcome.status} (${outcome.exitCode ?? outcome.signal ?? "unknown"}).`;
    throw Object.assign(new Error(evidenceError ? `${message} ${evidenceError}` : message), {
      code: "NATIVE_PROCESS_FAILED",
    });
  }
  if (evidenceError) throw new Error(evidenceError);
}

/** Schedule an already verified plan, with process admission owned by the caller. */
export async function executeNodeCheckPlan(
  plan: NodeCheckPlan,
  context: Partial<PipelineContext> & { cwd: string },
  run: CommandRunner,
  dryRun?: boolean,
  fileCheck?: FileCheckRunner
): Promise<NodeCheckExecution> {
  const { step } = createSteps();
  const steps = new Map<string, Step<string, CheckProcessOutcome | undefined, object>>();
  const commands: NodeCheckExecution["commands"] = [];
  const reports: NodeCheckExecution["reports"] = [];
  for (const command of plan.commands) {
    const files =
      command.kind === "vitest" && fileCheck?.stepId === command.id ? fileCheck : undefined;
    const report: NodeCheckExecution["reports"][number] | undefined =
      command.kind === "vitest" && (!files || files.mode === "files")
        ? { stepId: command.id, path: command.report.path, result: { state: "missing" } }
        : undefined;
    if (report) reports.push(report);
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
          if (files?.mode === "partitions" && command.kind === "vitest") {
            await files.run(command, ctx);
            return;
          }
          if (report) await prepareCheckReport(ctx.cwd, report.path);
          const observation =
            files && files.mode !== "partitions" && command.kind === "vitest"
              ? await files.run(command, ctx)
              : undefined;
          const outcome = observation?.process ?? (await run(command, ctx));
          commands.push({ id: command.id, process: outcome });
          if (report && command.kind === "vitest") {
            report.result = await collectVitestReport(command, ctx, outcome, Boolean(observation));
          }
          ctx.signal?.throwIfAborted();
          requireCheckSuccess(`Native command ${command.id}`, outcome, observation?.evidenceError);
          const collected = report?.result;
          if (
            !observation &&
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
  const target = fileCheck?.mode === "inventory" ? steps.get(fileCheck.stepId) : undefined;
  const pipeline = definePipeline({
    id: PIPELINE_ID,
    steps: [...steps.values()],
    ...(target ? { targets: [target] } : {}),
  });
  const execution = await pipeline.run(
    {},
    { maxConcurrency: plan.maxConcurrency, dryRun, ...(target ? { targets: [target.id] } : {}) },
    context
  );
  return { version: 1, run: execution, commands, reports };
}
