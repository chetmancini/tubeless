import type { ComponentChildren } from "preact";
import type { StoredPipelineStep } from "../run-store/run-store.js";
import { StepArtifacts } from "./run-store-ui-artifacts.js";

export const shortId = (id: string) => (id.length > 24 ? id.slice(0, 12) + "…" + id.slice(-7) : id);

export function duration(ms: number | null | undefined): string {
  return ms == null
    ? "—"
    : ms < 1000
      ? Math.max(0, Math.round(ms)) + " ms"
      : ms < 60000
        ? (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + " s"
        : Math.floor(ms / 60000) + "m " + Math.round((ms % 60000) / 1000) + "s";
}

function statusMark(value: string): string {
  return value === "completed"
    ? "✓"
    : value === "skipped"
      ? "×"
      : value === "cancelled"
        ? "■"
        : value === "failed"
          ? "!"
          : value === "planned"
            ? "…"
            : "";
}

export function Status({
  value,
  outputSource,
}: {
  value: string;
  outputSource?: "override" | "cache";
}) {
  return (
    <span class={`status ${value}`}>
      <i class="status-mark" aria-hidden="true">
        {statusMark(value)}
      </i>
      {value}
      {outputSource === "override" && " (overridden)"}
      {outputSource === "cache" && " (cached)"}
    </span>
  );
}

interface NestedDetailProps {
  children?: ComponentChildren;
  label: string;
  secondary?: string;
  stepIds?: readonly string[];
}

export function NestedDetail({ children, label, secondary, stepIds }: NestedDetailProps) {
  return (
    <div class="plan-nested">
      <strong>{label}</strong>
      {secondary && <span>{secondary}</span>}
      {stepIds?.map((stepId) => (
        <code key={stepId}>{stepId}</code>
      ))}
      {children}
    </div>
  );
}
function StepStatusIcon({ value }: { value: string }) {
  const label = value.charAt(0).toUpperCase() + value.slice(1);
  const icon =
    value === "completed" ? (
      <svg viewBox="0 0 12 12">
        <path d="m2 6 2.4 2.4L10 3" />
      </svg>
    ) : value === "running" ? (
      <i />
    ) : value === "skipped" ? (
      <svg viewBox="0 0 12 12">
        <path d="m3 3 6 6M9 3 3 9" />
      </svg>
    ) : value === "cancelled" ? (
      <svg viewBox="0 0 12 12">
        <rect x="3" y="3" width="6" height="6" rx="1" fill="currentColor" stroke="none" />
      </svg>
    ) : value === "failed" ? (
      "!"
    ) : (
      "…"
    );
  return (
    <span class={`step-status-icon ${value}`} role="img" aria-label={label} title={label}>
      {icon}
    </span>
  );
}

export function StepRow({ step }: { step: StoredPipelineStep }) {
  const progressTotal = step.progress?.total;
  const progressWidth = progressTotal
    ? Math.max(0, Math.min(100, ((step.progress?.completed ?? 0) / progressTotal) * 100))
    : step.status === "completed"
      ? 100
      : 18;
  const nested = step.nestedPipeline;
  const nestedCount = nested ? (nested.stepCount ?? nested.stepIds.length) : 0;
  const nestedCountLabel =
    nested && nested.stepIds.length < nestedCount
      ? nested.stepIds.length + " of " + nestedCount + " declared steps"
      : nestedCount + " declared steps";
  const detailCount = step.progress?.detailCount;
  return (
    <article class={`step ${step.status}`}>
      <StepStatusIcon value={step.status} />
      <div class="step-head">
        <strong>{step.name || step.id}</strong>
        {step.outputSource && <Status value={step.status} outputSource={step.outputSource} />}
        {step.name && <code>{step.id}</code>}
        <span class="step-duration">{duration(step.durationMs)}</span>
      </div>
      {step.description && <div class="step-description">{step.description}</div>}
      {nested && (
        <NestedDetail
          label={nested.pipelineId}
          secondary={`${nestedCountLabel}${nested.mode === "iterate" ? ` per iteration, at most ${nested.maxIterations} iterations` : nested.mode === "for-each" ? " per runtime item" : ""}`}
          stepIds={nested.stepIds}
        />
      )}
      {step.remote && <NestedDetail label={step.remote.engine} secondary={step.remote.target} />}
      {step.attempt && (
        <div class="execution">
          <span class="execution-summary" title={step.attempt.attemptId}>
            <b>
              {step.attempt.outputSource === "override"
                ? "Override validation"
                : step.attempt.outputSource === "cache"
                  ? "Cache validation"
                  : "Execution"}
            </b>{" "}
            · {shortId(step.attempt.attemptId)}
            {step.attempt.retries.length > 0 &&
              ` · ${step.attempt.retries.length} retr${
                step.attempt.retries.length === 1 ? "y" : "ies"
              }`}
          </span>
        </div>
      )}
      {step.artifacts && <StepArtifacts artifacts={step.artifacts} stepId={step.id} />}
      {step.progress && (
        <>
          <div class="progress">
            <i class={`w${Math.round(progressWidth)}`} />
          </div>
          <div class="progress-copy">
            {step.progress.message ||
              step.progress.completed + (progressTotal ? " / " + progressTotal : "") + " complete"}
          </div>
          {step.progress.details && step.progress.details.length > 0 && (
            <div class="progress-details">
              {step.progress.details.map((detail) => (
                <div class={`progress-detail ${detail.status || "running"}`} key={detail.id}>
                  <b>{detail.id}</b>
                  {detail.label && <span>{detail.label}</span>}
                  {detail.outputSource === "override" && <span>(overridden)</span>}
                  {detail.outputSource === "cache" && <span>(cached)</span>}
                </div>
              ))}
              {detailCount && step.progress.details.length < detailCount ? (
                <div class="progress-detail-truncated">
                  Showing {step.progress.details.length} of {detailCount} items
                </div>
              ) : null}
            </div>
          )}
        </>
      )}
    </article>
  );
}
