import type { CheckFailure, StructuredError } from "../../../utilities/check-report.js";
import { terminalSafeText } from "../../workbench-shared.js";
import type { cloudOutput } from "../output.js";
import type { CliRun } from "../protocol.js";

type Output = ReturnType<typeof cloudOutput>;

function describeError(error: StructuredError, text: Output["text"]): string {
  const codes = [error.code, error.sourceCode].filter(Boolean).join(", ");
  const cause = error.cause;
  return (
    text(error.message) +
    (codes ? ` (${text(codes)})` : "") +
    (cause ? `\n    Caused by: ${text(cause.message)}` : "")
  );
}

function failureLocation(failure: Pick<CheckFailure, "file" | "line" | "column">): string {
  return [failure.file, failure.line, failure.column]
    .filter((part) => part !== undefined)
    .join(":");
}

export function formatRunInspection(run: CliRun, output: Output, url: string): string {
  const { text, json } = output;
  const lines = [
    `Run ${text(run.id)}: ${run.status}`,
    `Pipeline: ${text(run.pipelineName)} (${text(run.pipelineId)})`,
    `Source: ${text(run.branch)} @ ${text(run.commit)}`,
    url,
  ];
  if (run.sourceIdentity)
    lines.push(`Source identity: ${terminalSafeText(json(run.sourceIdentity))}`);
  if (run.error) lines.push(`Error: ${text(run.error)}`);

  if (run.steps.length) lines.push("Steps:");
  for (const step of run.steps) {
    lines.push(`  ${text(step.id)}: ${step.status} (${step.durationMs} ms)`);
    if (step.structuredError) lines.push(`    ${describeError(step.structuredError, text)}`);
    else if (step.error) lines.push(`    ${text(step.error)}`);
  }
  for (const error of run.structuredErrors ?? []) {
    if (
      run.steps.some(
        (step) => step.id === error.stepId && step.structuredError?.message === error.message
      )
    )
      continue;
    const scope = error.stepId ? ` (${text(error.stepId)})` : "";
    lines.push(`Error${scope}: ${describeError(error, text)}`);
  }
  if (run.omittedStructuredErrors)
    lines.push(`Omitted structured errors: ${run.omittedStructuredErrors}`);
  for (const command of run.nativeCommands ?? [])
    lines.push(`Command ${text(command.id)}: exit ${command.exitCode} (${command.durationMs} ms)`);

  const diagnostics = run.diagnostics;
  if (diagnostics) {
    lines.push(`Diagnostics: ${diagnostics.state}`);
    for (const { artifact, result } of diagnostics.reports) {
      if (result.state !== "available") {
        lines.push(`  ${text(artifact)}: ${result.state}`);
        continue;
      }
      const { report } = result;
      const failed = report.tests.filter((test) => test.outcome === "failed");
      lines.push(
        `  ${text(artifact)}: ${report.completeness}, ${failed.length} failed tests, ${report.omittedTests} omitted tests`
      );
      for (const test of failed) {
        const name = [...test.suite, test.title].join(" › ");
        lines.push(`    ${text(failureLocation(test))} — ${text(name)}`);
        if (test.failures[0]) lines.push(`      ${text(test.failures[0].message)}`);
      }
      for (const failure of report.failures) {
        const location = failureLocation(failure);
        lines.push(`    ${location ? `${text(location)} — ` : ""}${text(failure.message)}`);
      }
    }
    if (diagnostics.omitted) lines.push(`  Omitted reports: ${diagnostics.omitted}`);
  }
  if (run.result !== undefined) lines.push(`Result: ${terminalSafeText(json(run.result))}`);
  if (run.artifacts.length) lines.push("Artifacts:");
  for (const { name, size, contentType } of run.artifacts)
    lines.push(`  ${text(name)} (${size} bytes, ${text(contentType)})`);
  return `${lines.join("\n")}\n`;
}
