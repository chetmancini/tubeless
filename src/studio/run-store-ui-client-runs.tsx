import type { StoredPipelineRun, StoredPipelineStep } from "../run-store/run-store.js";
import type { StudioRunIndex, StudioSnapshot } from "./run-store-ui-client-model.js";
import {
  clock,
  dateTime,
  duration,
  EmptyView,
  isoTime,
  NestedDetail,
  relativeTime,
  shortId,
  Status,
} from "./run-store-ui-client-shared.js";

export function Metrics({
  commandCount,
  snapshot,
}: {
  commandCount: number;
  snapshot: StudioSnapshot;
}) {
  const terminal = snapshot.completedRunCount + snapshot.failedRunCount;
  const success = terminal ? Math.round((snapshot.completedRunCount / terminal) * 100) : 0;
  const pipelineCount = commandCount || snapshot.definitions.length;
  const metrics = [
    [
      "Active now",
      snapshot.activeRunCount,
      snapshot.activeRunCount ? "Live execution in progress" : "No work in flight",
    ],
    ["Recorded runs", snapshot.runs.length, "Append-only local history"],
    ["Success rate", success + "%", terminal + " terminal runs"],
    [
      "Pipelines",
      pipelineCount,
      commandCount ? "Available to configure" : "Observed in run history",
    ],
  ];
  return (
    <>
      {metrics.map(([label, value, note]) => (
        <article class="metric" key={label}>
          <div class="metric-label">{label}</div>
          <div class="metric-value">{value}</div>
          <div class="metric-note">{note}</div>
        </article>
      ))}
    </>
  );
}

interface RunRowProps {
  nowMs: number;
  onSelect(id: string): void;
  run: StoredPipelineRun;
  runIndex: StudioRunIndex;
  selectedRunId: string | null;
}

function RunRow({ nowMs, onSelect, run, runIndex, selectedRunId }: RunRowProps) {
  const activeStep = run.steps.find((step) => step.status === "running");
  const nestedCount = runIndex.descendantCount(run.runId);
  return (
    <button
      class={`run-row ${run.status} ${
        runIndex.rootRunId(selectedRunId) === run.runId ? "selected" : ""
      }`}
      data-run-id={run.runId}
      onClick={() => onSelect(run.runId)}
    >
      <div class="run-primary">
        <Status value={run.status} />
        <strong>{run.pipelineId}</strong>
        <time
          class="run-time"
          datetime={isoTime(run.startedAtMs)}
          title={dateTime(run.startedAtMs)}
        >
          {relativeTime(run.startedAtMs, nowMs)}
        </time>
      </div>
      <div class="run-secondary">
        <code>{shortId(run.runId)}</code>
        <i class="dot" />
        {run.correlationId && (
          <>
            <span>correlation {run.correlationId}</span>
            <i class="dot" />
          </>
        )}
        <span>{duration(run.durationMs)}</span>
        <i class="dot" />
        <span>{run.steps.length} steps</span>
        {nestedCount > 0 && (
          <>
            <i class="dot" />
            <span>
              {nestedCount} nested run{nestedCount === 1 ? "" : "s"}
            </span>
          </>
        )}
        {run.dryRun && (
          <>
            <i class="dot" />
            <span>dry run</span>
          </>
        )}
      </div>
      {run.status === "running" && (
        <div class="run-activity">
          <strong>{activeStep?.name || activeStep?.id || "Starting"}</strong>
          <span>{activeStep?.progress?.message || "Execution in progress"}</span>
        </div>
      )}
    </button>
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

function StepRow({ step }: { step: StoredPipelineStep }) {
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
        {step.name && <code>{step.id}</code>}
        <span class="step-duration">{duration(step.durationMs)}</span>
      </div>
      {step.description && <div class="step-description">{step.description}</div>}
      {nested && (
        <NestedDetail
          label={nested.pipelineId}
          secondary={`${nestedCountLabel}${nested.mode === "for-each" ? " per runtime item" : ""}`}
          stepIds={nested.stepIds}
        />
      )}
      {step.remote && <NestedDetail label={step.remote.engine} secondary={step.remote.target} />}
      {step.attempt && (
        <div class="execution">
          <span class="execution-summary" title={step.attempt.attemptId}>
            <b>Execution</b> · {shortId(step.attempt.attemptId)}
            {step.attempt.retries.length > 0 &&
              ` · ${step.attempt.retries.length} retr${
                step.attempt.retries.length === 1 ? "y" : "ies"
              }`}
          </span>
        </div>
      )}
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

function stepSummary(run: StoredPipelineRun): string {
  const order = ["running", "failed", "cancelled", "skipped", "completed", "planned"] as const;
  return (
    order
      .map((value) => [value, run.steps.filter((step) => step.status === value).length] as const)
      .filter(([, count]) => count)
      .map(([value, count]) => count + " " + value)
      .join(" · ") || "No steps"
  );
}

interface RunDetailProps {
  canCancel: boolean;
  cancelling: boolean;
  liveRunIds: readonly string[];
  nowMs: number;
  onCancel(id: string): void;
  onSelect(id: string): void;
  run: StoredPipelineRun | null;
  runIndex: StudioRunIndex;
}

function RunDetail({
  canCancel,
  cancelling,
  liveRunIds,
  nowMs,
  onCancel,
  onSelect,
  run,
  runIndex,
}: RunDetailProps) {
  if (!run) {
    return (
      <div class="sheet detail">
        <EmptyView
          title="Select a run"
          copy="Choose a run from the history to inspect its steps, retry telemetry, logs, and errors."
        />
      </div>
    );
  }
  const ancestors = runIndex.ancestorsOf(run.runId);
  const children = runIndex.childrenOf(run.runId);
  return (
    <article class="sheet detail">
      <div class="detail-body">
        {ancestors.length > 0 && (
          <div class="run-parentage">
            {ancestors.map((ancestor) => (
              <span key={ancestor.runId}>
                <button type="button" onClick={() => onSelect(ancestor.runId)}>
                  {ancestor.pipelineId}
                </button>
                <span> / </span>
              </span>
            ))}
            <span>{run.pipelineId}</span>
          </div>
        )}
        <div class="detail-heading">
          <div class="detail-heading-copy">
            <div class="detail-kicker">
              {run.parentRunId ? "Nested run" : "Top-level run"} ·{" "}
              {relativeTime(run.startedAtMs, nowMs)}
            </div>
            <h2>{run.pipelineId}</h2>
            <div class="run-id">{run.runId}</div>
            {run.correlationId && <div class="run-id">Correlation: {run.correlationId}</div>}
          </div>
          <div class="detail-heading-actions">
            <Status value={run.status} />
            {canCancel &&
              run.status === "running" &&
              !run.parentRunId &&
              liveRunIds.includes(run.runId) && (
                <button
                  class="danger-button"
                  type="button"
                  disabled={cancelling}
                  onClick={() => onCancel(run.runId)}
                >
                  Cancel run
                </button>
              )}
          </div>
        </div>
        <div class="detail-meta">
          <div>
            <label>Started</label>
            <span title={isoTime(run.startedAtMs)}>{dateTime(run.startedAtMs)}</span>
          </div>
          <div>
            <label>Duration</label>
            <span>{duration(run.durationMs)}</span>
          </div>
          <div>
            <label>Steps</label>
            <span>{run.steps.length}</span>
          </div>
          <div>
            <label>Events</label>
            <span>{run.eventCount}</span>
          </div>
        </div>
        {children.length > 0 && (
          <>
            <div class="section-title">
              <span>Nested runs</span>
              <span>
                {children.length} direct · {runIndex.descendantCount(run.runId)} total
              </span>
            </div>
            <div class="nested-runs">
              {children.map((child) => {
                const descendantCount = runIndex.descendantCount(child.runId);
                return (
                  <button
                    class="nested-run"
                    type="button"
                    key={child.runId}
                    onClick={() => onSelect(child.runId)}
                  >
                    <Status value={child.status} />
                    <strong>{child.pipelineId}</strong>
                    <small>
                      {duration(child.durationMs)} · {child.steps.length} steps
                      {descendantCount ? " · " + descendantCount + " nested" : ""}
                    </small>
                  </button>
                );
              })}
            </div>
          </>
        )}
        <div class="section-title">
          <span>Step timeline</span>
          <span>{stepSummary(run)}</span>
        </div>
        {run.steps.length ? (
          <div class="step-list">
            {run.steps.map((step) => (
              <StepRow key={step.id} step={step} />
            ))}
          </div>
        ) : (
          <EmptyView
            title="No planned steps"
            copy="This run ended before a step plan was recorded."
          />
        )}
        {run.error && (
          <>
            <div class="section-title">
              <span>Error</span>
            </div>
            <div class="error-card">
              <div class="error-code">
                {run.error.code} · {run.error.phase}
              </div>
              <div class="error-message">{run.error.message}</div>
            </div>
          </>
        )}
        {run.logs.length > 0 && (
          <>
            <div class="section-title">
              <span>Logs</span>
              <span>{run.logs.length}</span>
            </div>
            <div class="logs">
              {run.logs.map((log) => (
                <div class="log-line" key={log.id}>
                  <time class="log-time">{clock(log.timestampMs)}</time>
                  <span class={`log-level ${log.level}`}>{log.level}</span>
                  <span class="log-message">
                    {log.stepId && (
                      <>
                        <b>{log.stepId}</b> ·{" "}
                      </>
                    )}
                    {log.message}
                  </span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </article>
  );
}

interface RunsViewProps extends Omit<RunDetailProps, "run"> {
  roots: readonly StoredPipelineRun[];
  selectedRun: StoredPipelineRun | null;
  selectedRunId: string | null;
  totalRunCount: number;
}

export function RunsView(props: RunsViewProps) {
  const activeRuns = props.roots.filter((run) => props.runIndex.subtreeIsRunning(run.runId));
  const historicalRuns = props.roots.filter((run) => !props.runIndex.subtreeIsRunning(run.runId));
  const list = (label: string, runs: readonly StoredPipelineRun[]) =>
    runs.length ? (
      <>
        <div class="run-group">
          {label} · {runs.length}
        </div>
        {runs.map((run) => (
          <RunRow
            key={run.runId}
            nowMs={props.nowMs}
            onSelect={props.onSelect}
            run={run}
            runIndex={props.runIndex}
            selectedRunId={props.selectedRunId}
          />
        ))}
      </>
    ) : null;
  return (
    <div class="content-grid">
      <section class="sheet">
        <div class="sheet-head">
          <div>
            <div class="sheet-title">Pipeline runs</div>
            <div class="sheet-subtitle">Top-level runs · nested work stays with its parent</div>
          </div>
          <span class="sheet-subtitle">
            {props.roots.length} top-level · {props.totalRunCount} total
          </span>
        </div>
        <div class="run-list">
          {props.roots.length ? (
            <>
              {list("Running now", activeRuns)}
              {list("Recent", historicalRuns)}
            </>
          ) : (
            <EmptyView
              title="No recorded runs"
              copy="Choose Pipelines to start a run and create local history."
            />
          )}
        </div>
      </section>
      <RunDetail {...props} run={props.selectedRun} />
    </div>
  );
}
