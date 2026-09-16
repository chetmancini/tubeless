import type { CliParameterDescriptor } from "../cli/cli.js";
import type { PipelinePlan } from "../core/pipeline.js";
import type { StoredPipelineRun, StoredPipelineStep } from "../run-store/run-store.js";
import type { StudioRunIndex, StudioSnapshot } from "./run-store-ui-client-model.js";
import type { PipelineRunStudioCommand } from "./run-store-ui-protocol.js";

export const escapeHtml = (value: string | number | boolean | null | undefined) =>
  String(value ?? "").replace(/[&<>"']/g, (char) =>
    char === "&"
      ? "&amp;"
      : char === "<"
        ? "&lt;"
        : char === ">"
          ? "&gt;"
          : char === '"'
            ? "&quot;"
            : "&#039;"
  );

export const shortId = (id: string) => (id.length > 24 ? id.slice(0, 12) + "…" + id.slice(-7) : id);

export function commandDescription(command: PipelineRunStudioCommand): string {
  return command.description || "Run this typed pipeline command.";
}

function parameterLabel(parameter: CliParameterDescriptor) {
  return parameter.key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function parameterHint(parameter: CliParameterDescriptor) {
  const details = [];
  if (parameter.description) details.push(parameter.description);
  if (parameter.environment) details.push("Environment fallback: " + parameter.environment);
  if (parameter.multiple)
    details.push(parameter.choices ? "Choose one or more values." : "Enter one value per line.");
  if (parameter.mustExist)
    details.push("Must be an existing " + (parameter.pathKind || "path") + ".");
  return details.join(" ");
}

function parameterControl(parameter: CliParameterDescriptor, index: number, scope: string) {
  const id = scope + "-param-" + index;
  const data = " data-" + scope + '-parameter-index="' + index + '"';
  const hint = parameterHint(parameter);
  const labelText = parameterLabel(parameter);
  if (parameter.type === "boolean") {
    return (
      '<label class="boolean-field" for="' +
      id +
      '"><span><strong>' +
      escapeHtml(labelText) +
      "</strong><small>" +
      escapeHtml(hint || "Enable this option.") +
      '</small></span><input id="' +
      id +
      '" type="checkbox"' +
      data +
      (parameter.default ? " checked" : "") +
      "></label>"
    );
  }
  const required = parameter.required ? " required" : "";
  const label =
    '<label for="' +
    id +
    '">' +
    escapeHtml(labelText) +
    (parameter.required ? '<span class="required-mark">required</span>' : "") +
    "</label>";
  let control;
  if (parameter.choices) {
    const emptyOption =
      parameter.multiple || parameter.required
        ? ""
        : '<option value="">Use default or leave unset</option>';
    const options = parameter.choices
      .map(
        (choice) =>
          '<option value="' +
          escapeHtml(choice) +
          '"' +
          (choice === parameter.default ? " selected" : "") +
          ">" +
          escapeHtml(choice) +
          "</option>"
      )
      .join("");
    control =
      '<select id="' +
      id +
      '"' +
      data +
      (parameter.multiple ? " multiple" : "") +
      required +
      ">" +
      emptyOption +
      options +
      "</select>";
  } else if (parameter.multiple) {
    control =
      '<textarea id="' +
      id +
      '"' +
      data +
      ' spellcheck="false" placeholder="One value per line"></textarea>';
  } else {
    const inputType = parameter.type === "number" ? "number" : "text";
    const value = parameter.default === undefined ? "" : String(parameter.default);
    const constraints =
      parameter.type === "number"
        ? (parameter.integer ? ' step="1"' : ' step="any"') +
          (parameter.min === undefined ? "" : ' min="' + escapeHtml(parameter.min) + '"') +
          (parameter.max === undefined ? "" : ' max="' + escapeHtml(parameter.max) + '"')
        : "";
    const placeholder =
      parameter.type === "path"
        ? parameter.pathKind === "directory"
          ? "./directory"
          : "./file"
        : "";
    control =
      '<input id="' +
      id +
      '" type="' +
      inputType +
      '"' +
      data +
      ' value="' +
      escapeHtml(value) +
      '" placeholder="' +
      placeholder +
      '"' +
      constraints +
      required +
      ">";
  }
  return (
    '<div class="field">' +
    label +
    control +
    (hint ? '<div class="field-hint">' + escapeHtml(hint) + "</div>" : "") +
    "</div>"
  );
}

function renderParameters(command: PipelineRunStudioCommand, scope: string, keys: Set<string>) {
  return command.parameters
    .map((parameter, index) =>
      keys.has(parameter.key) ? parameterControl(parameter, index, scope) : ""
    )
    .join("");
}

export function renderCommandFormFields(command: PipelineRunStudioCommand): string {
  const domainKeys = new Set(
    command.parameters
      .filter((parameter) => parameter.group !== "execution")
      .map((parameter) => parameter.key)
  );
  const executionKeys = new Set(
    command.parameters
      .filter((parameter) => parameter.group === "execution")
      .map((parameter) => parameter.key)
  );
  const section = (title: string, note: string, keys: Set<string>) =>
    keys.size
      ? '<section class="form-section"><div class="form-section-head"><strong>' +
        title +
        "</strong><span>" +
        note +
        '</span></div><div class="parameter-grid">' +
        renderParameters(command, "run", keys) +
        "</div></section>"
      : "";
  return (
    section(
      "Pipeline inputs",
      domainKeys.size + " parameter" + (domainKeys.size === 1 ? "" : "s"),
      domainKeys
    ) + section("Execution controls", "Built into Tubeless", executionKeys)
  );
}

function statusMark(value: string) {
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

function status(value: string) {
  return (
    '<span class="status ' +
    escapeHtml(value) +
    '"><i class="status-mark" aria-hidden="true">' +
    statusMark(value) +
    "</i>" +
    escapeHtml(value) +
    "</span>"
  );
}

function duration(ms: number | null | undefined) {
  return ms == null
    ? "—"
    : ms < 1000
      ? Math.max(0, Math.round(ms)) + " ms"
      : ms < 60000
        ? (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + " s"
        : Math.floor(ms / 60000) + "m " + Math.round((ms % 60000) / 1000) + "s";
}

function clock(ms: number) {
  if (!Number.isFinite(ms) || Math.abs(ms) > 8.64e15) return "";
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(ms);
}

function dateTime(ms: number) {
  if (!Number.isFinite(ms) || Math.abs(ms) > 8.64e15) return "";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" }).format(
    ms
  );
}

function isoTime(ms: number) {
  if (!Number.isFinite(ms) || Math.abs(ms) > 8.64e15) return "";
  return new Date(ms).toISOString();
}

function relative(ms: number, nowMs: number) {
  const delta = Math.max(0, nowMs - ms);
  if (delta < 60000) return Math.floor(delta / 1000) + "s ago";
  if (delta < 3600000) return Math.floor(delta / 60000) + "m ago";
  if (delta < 86400000) return Math.floor(delta / 3600000) + "h ago";
  return Math.floor(delta / 86400000) + "d ago";
}

export function renderMetrics(snapshot: StudioSnapshot, commandCount: number): string {
  const terminal = snapshot.completedRunCount + snapshot.failedRunCount;
  const success = terminal ? Math.round((snapshot.completedRunCount / terminal) * 100) : 0;
  const pipelineCount = commandCount || snapshot.definitions.length;
  return [
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
  ]
    .map(
      ([label, value, note]) =>
        '<article class="metric"><div class="metric-label">' +
        label +
        '</div><div class="metric-value">' +
        value +
        '</div><div class="metric-note">' +
        note +
        "</div></article>"
    )
    .join("");
}

function emptyView(title: string, copy: string): string {
  return (
    '<div class="empty"><div><div class="empty-icon"><svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M4 5.5h12M4 10h12M4 14.5h8"/></svg></div><strong>' +
    escapeHtml(title) +
    "</strong><p>" +
    escapeHtml(copy) +
    "</p></div></div>"
  );
}

export function renderPipelinesView(commands: readonly PipelineRunStudioCommand[]): string {
  if (!commands.length) {
    return (
      '<div class="sheet">' +
      emptyView("No pipelines found", "Try a different pipeline name or description.") +
      "</div>"
    );
  }
  return (
    '<section class="sheet"><div class="sheet-head"><div><div class="sheet-title">Available pipelines</div><div class="sheet-subtitle">Declared by the local studio manifest</div></div><span class="sheet-subtitle">' +
    commands.length +
    ' shown</span></div><div class="catalog">' +
    commands
      .map(
        (command) =>
          '<article class="catalog-card"><h3>' +
          escapeHtml(command.name) +
          "</h3><p>" +
          escapeHtml(commandDescription(command)) +
          '</p><div class="catalog-actions"><button class="primary-button" data-command-id="' +
          escapeHtml(command.id) +
          '">Configure</button></div></article>'
      )
      .join("") +
    "</div></section>"
  );
}

function runRow(
  run: StoredPipelineRun,
  runIndex: StudioRunIndex,
  selectedRunId: string | null,
  nowMs: number
) {
  const activeStep = run.steps.find((step) => step.status === "running");
  const nestedCount = runIndex.descendantCount(run.runId);
  const activity =
    run.status === "running"
      ? '<div class="run-activity"><strong>' +
        escapeHtml(activeStep?.name || activeStep?.id || "Starting") +
        "</strong><span>" +
        escapeHtml(activeStep?.progress?.message || "Execution in progress") +
        "</span></div>"
      : "";
  return (
    '<button class="run-row ' +
    escapeHtml(run.status) +
    " " +
    (runIndex.rootRunId(selectedRunId) === run.runId ? "selected" : "") +
    '" data-run-id="' +
    escapeHtml(run.runId) +
    '"><div class="run-primary">' +
    status(run.status) +
    "<strong>" +
    escapeHtml(run.pipelineId) +
    '</strong><time class="run-time" datetime="' +
    isoTime(run.startedAtMs) +
    '" title="' +
    escapeHtml(dateTime(run.startedAtMs)) +
    '">' +
    relative(run.startedAtMs, nowMs) +
    '</time></div><div class="run-secondary"><code>' +
    escapeHtml(shortId(run.runId)) +
    '</code><i class="dot"></i><span>' +
    (run.correlationId
      ? "correlation " + escapeHtml(run.correlationId) + '</span><i class="dot"></i><span>'
      : "") +
    duration(run.durationMs) +
    '</span><i class="dot"></i><span>' +
    run.steps.length +
    " steps</span>" +
    (nestedCount
      ? '<i class="dot"></i><span>' +
        nestedCount +
        " nested run" +
        (nestedCount === 1 ? "" : "s") +
        "</span>"
      : "") +
    (run.dryRun ? '<i class="dot"></i><span>dry run</span>' : "") +
    "</div>" +
    activity +
    "</button>"
  );
}

function stepStatusIcon(value: string) {
  const label = value.charAt(0).toUpperCase() + value.slice(1);
  const icon =
    value === "completed"
      ? '<svg viewBox="0 0 12 12"><path d="m2 6 2.4 2.4L10 3"/></svg>'
      : value === "running"
        ? "<i></i>"
        : value === "skipped"
          ? '<svg viewBox="0 0 12 12"><path d="m3 3 6 6M9 3 3 9"/></svg>'
          : value === "cancelled"
            ? '<svg viewBox="0 0 12 12"><rect x="3" y="3" width="6" height="6" rx="1" fill="currentColor" stroke="none"/></svg>'
            : value === "failed"
              ? "!"
              : "…";
  return (
    '<span class="step-status-icon ' +
    escapeHtml(value) +
    '" role="img" aria-label="' +
    escapeHtml(label) +
    '" title="' +
    escapeHtml(label) +
    '">' +
    icon +
    "</span>"
  );
}

function stepRow(step: StoredPipelineStep) {
  const progressTotal = step.progress?.total;
  const progressWidth = progressTotal
    ? Math.max(0, Math.min(100, ((step.progress?.completed ?? 0) / progressTotal) * 100))
    : step.status === "completed"
      ? 100
      : 18;
  const execution = step.attempt
    ? '<span class="execution-summary" title="' +
      escapeHtml(step.attempt.attemptId) +
      '"><b>Execution</b> · ' +
      escapeHtml(shortId(step.attempt.attemptId)) +
      (step.attempt.retries.length
        ? " · " +
          step.attempt.retries.length +
          " retr" +
          (step.attempt.retries.length === 1 ? "y" : "ies")
        : "") +
      "</span>"
    : "";
  const nested = step.nestedPipeline;
  const remote = step.remote;
  const nestedCount = nested ? (nested.stepCount ?? nested.stepIds.length) : 0;
  const nestedCountLabel =
    nested && nested.stepIds.length < nestedCount
      ? nested.stepIds.length + " of " + nestedCount + " declared steps"
      : nestedCount + " declared steps";
  const nestedDetail = nested
    ? '<div class="plan-nested"><strong>' +
      escapeHtml(nested.pipelineId) +
      "</strong><span>" +
      nestedCountLabel +
      (nested.mode === "for-each" ? " per runtime item" : "") +
      "</span>" +
      nested.stepIds.map((stepId) => "<code>" + escapeHtml(stepId) + "</code>").join("") +
      "</div>"
    : "";
  const remoteDetail = remote
    ? '<div class="plan-nested"><strong>' +
      escapeHtml(remote.engine) +
      "</strong>" +
      (remote.target ? "<span>" + escapeHtml(remote.target) + "</span>" : "") +
      "</div>"
    : "";
  const detailCount = step.progress?.detailCount;
  const truncatedDetails =
    detailCount && step.progress?.details && step.progress.details.length < detailCount
      ? '<div class="progress-detail-truncated">Showing ' +
        step.progress.details.length +
        " of " +
        detailCount +
        " items</div>"
      : "";
  const detailRows = step.progress?.details?.length
    ? '<div class="progress-details">' +
      step.progress.details
        .map(
          (detail) =>
            '<div class="progress-detail ' +
            escapeHtml(detail.status || "running") +
            '"><b>' +
            escapeHtml(detail.id) +
            "</b>" +
            (detail.label ? "<span>" + escapeHtml(detail.label) + "</span>" : "") +
            "</div>"
        )
        .join("") +
      truncatedDetails +
      "</div>"
    : "";
  const progress = step.progress
    ? '<div class="progress"><i class="w' +
      Math.round(progressWidth) +
      '"></i></div><div class="progress-copy">' +
      escapeHtml(
        step.progress.message ||
          step.progress.completed + (progressTotal ? " / " + progressTotal : "") + " complete"
      ) +
      "</div>" +
      detailRows
    : "";
  return (
    '<article class="step ' +
    escapeHtml(step.status) +
    '">' +
    stepStatusIcon(step.status) +
    '<div class="step-head"><strong>' +
    escapeHtml(step.name || step.id) +
    "</strong>" +
    (step.name ? "<code>" + escapeHtml(step.id) + "</code>" : "") +
    '<span class="step-duration">' +
    duration(step.durationMs) +
    "</span></div>" +
    (step.description
      ? '<div class="step-description">' + escapeHtml(step.description) + "</div>"
      : "") +
    nestedDetail +
    remoteDetail +
    (execution ? '<div class="execution">' + execution + "</div>" : "") +
    progress +
    "</article>"
  );
}

function stepSummary(run: StoredPipelineRun) {
  const order = ["running", "failed", "cancelled", "skipped", "completed", "planned"] as const;
  return (
    order
      .map((value) => [value, run.steps.filter((step) => step.status === value).length] as const)
      .filter(([, count]) => count)
      .map(([value, count]) => count + " " + value)
      .join(" · ") || "No steps"
  );
}

interface RunDetailViewInput {
  canCancel: boolean;
  cancelling: boolean;
  liveRunIds: readonly string[];
  nowMs: number;
  run: StoredPipelineRun | null;
  runIndex: StudioRunIndex;
}

function runDetailView(input: RunDetailViewInput) {
  const { canCancel, cancelling, liveRunIds, nowMs, run, runIndex } = input;
  if (!run) {
    return (
      '<div class="sheet detail">' +
      emptyView(
        "Select a run",
        "Choose a run from the history to inspect its steps, retry telemetry, logs, and errors."
      ) +
      "</div>"
    );
  }
  const ancestors = runIndex.ancestorsOf(run.runId);
  const parentage = ancestors.length
    ? '<div class="run-parentage">' +
      ancestors
        .map(
          (ancestor) =>
            '<button type="button" data-detail-run-id="' +
            escapeHtml(ancestor.runId) +
            '">' +
            escapeHtml(ancestor.pipelineId) +
            "</button><span>/</span>"
        )
        .join("") +
      "<span>" +
      escapeHtml(run.pipelineId) +
      "</span></div>"
    : "";
  const children = runIndex.childrenOf(run.runId);
  const nested = children.length
    ? '<div class="section-title"><span>Nested runs</span><span>' +
      children.length +
      " direct · " +
      runIndex.descendantCount(run.runId) +
      ' total</span></div><div class="nested-runs">' +
      children
        .map((child) => {
          const descendantCount = runIndex.descendantCount(child.runId);
          return (
            '<button class="nested-run" type="button" data-detail-run-id="' +
            escapeHtml(child.runId) +
            '">' +
            status(child.status) +
            "<strong>" +
            escapeHtml(child.pipelineId) +
            "</strong><small>" +
            duration(child.durationMs) +
            " · " +
            child.steps.length +
            " steps" +
            (descendantCount ? " · " + descendantCount + " nested" : "") +
            "</small></button>"
          );
        })
        .join("") +
      "</div>"
    : "";
  const error = run.error
    ? '<div class="section-title"><span>Error</span></div><div class="error-card"><div class="error-code">' +
      escapeHtml(run.error.code) +
      " · " +
      escapeHtml(run.error.phase) +
      '</div><div class="error-message">' +
      escapeHtml(run.error.message) +
      "</div></div>"
    : "";
  const logs = run.logs.length
    ? '<div class="section-title"><span>Logs</span><span>' +
      run.logs.length +
      '</span></div><div class="logs">' +
      run.logs
        .map(
          (log) =>
            '<div class="log-line"><time class="log-time">' +
            clock(log.timestampMs) +
            '</time><span class="log-level ' +
            escapeHtml(log.level) +
            '">' +
            escapeHtml(log.level) +
            '</span><span class="log-message">' +
            (log.stepId ? "<b>" + escapeHtml(log.stepId) + "</b> · " : "") +
            escapeHtml(log.message) +
            "</span></div>"
        )
        .join("") +
      "</div>"
    : "";
  return (
    '<article class="sheet detail"><div class="detail-body">' +
    parentage +
    '<div class="detail-heading"><div class="detail-heading-copy"><div class="detail-kicker">' +
    (run.parentRunId ? "Nested run" : "Top-level run") +
    " · " +
    relative(run.startedAtMs, nowMs) +
    "</div><h2>" +
    escapeHtml(run.pipelineId) +
    '</h2><div class="run-id">' +
    escapeHtml(run.runId) +
    "</div>" +
    (run.correlationId
      ? '<div class="run-id">Correlation: ' + escapeHtml(run.correlationId) + "</div>"
      : "") +
    '</div><div class="detail-heading-actions">' +
    status(run.status) +
    (canCancel && run.status === "running" && !run.parentRunId && liveRunIds.includes(run.runId)
      ? '<button class="danger-button" type="button" data-cancel-run-id="' +
        escapeHtml(run.runId) +
        '"' +
        (cancelling ? " disabled" : "") +
        ">Cancel run</button>"
      : "") +
    '</div></div><div class="detail-meta"><div><label>Started</label><span title="' +
    escapeHtml(isoTime(run.startedAtMs)) +
    '">' +
    escapeHtml(dateTime(run.startedAtMs)) +
    "</span></div><div><label>Duration</label><span>" +
    duration(run.durationMs) +
    "</span></div><div><label>Steps</label><span>" +
    run.steps.length +
    "</span></div><div><label>Events</label><span>" +
    run.eventCount +
    "</span></div></div>" +
    nested +
    '<div class="section-title"><span>Step timeline</span><span>' +
    stepSummary(run) +
    "</span></div>" +
    (run.steps.length
      ? '<div class="step-list">' + run.steps.map(stepRow).join("") + "</div>"
      : emptyView("No planned steps", "This run ended before a step plan was recorded.")) +
    error +
    logs +
    "</div></article>"
  );
}

interface RunsViewInput {
  canCancel: boolean;
  cancelling: boolean;
  liveRunIds: readonly string[];
  nowMs: number;
  roots: readonly StoredPipelineRun[];
  runIndex: StudioRunIndex;
  selectedRun: StoredPipelineRun | null;
  selectedRunId: string | null;
  totalRunCount: number;
}

export function renderRunsView(input: RunsViewInput): string {
  const activeRuns: StoredPipelineRun[] = [];
  const historicalRuns: StoredPipelineRun[] = [];
  for (const root of input.roots) {
    if (input.runIndex.subtreeIsRunning(root.runId)) activeRuns.push(root);
    else historicalRuns.push(root);
  }
  const row = (run: StoredPipelineRun) =>
    runRow(run, input.runIndex, input.selectedRunId, input.nowMs);
  const activeList = activeRuns.length
    ? '<div class="run-group">Running now · ' +
      activeRuns.length +
      "</div>" +
      activeRuns.map(row).join("")
    : "";
  const historyList = historicalRuns.length
    ? '<div class="run-group">Recent · ' +
      historicalRuns.length +
      "</div>" +
      historicalRuns.map(row).join("")
    : "";
  return (
    '<div class="content-grid"><section class="sheet"><div class="sheet-head"><div><div class="sheet-title">Pipeline runs</div><div class="sheet-subtitle">Top-level runs · nested work stays with its parent</div></div><span class="sheet-subtitle">' +
    input.roots.length +
    " top-level · " +
    input.totalRunCount +
    ' total</span></div><div class="run-list">' +
    (input.roots.length
      ? activeList + historyList
      : emptyView(
          "No recorded runs",
          "Choose Pipelines to start a run and create local history."
        )) +
    "</div></section>" +
    runDetailView({
      canCancel: input.canCancel,
      cancelling: input.cancelling,
      liveRunIds: input.liveRunIds,
      nowMs: input.nowMs,
      run: input.selectedRun,
      runIndex: input.runIndex,
    }) +
    "</div>"
  );
}

export function renderPlanView(plan: PipelinePlan): string {
  const selected = plan.steps.filter((step) => step.selected && !step.skipReason).length;
  const errors = plan.errors.length
    ? '<div class="launch-error">' +
      plan.errors.map((error) => escapeHtml(error.message)).join("<br>") +
      "</div>"
    : "";
  const steps = plan.steps
    .map((step) => {
      const disposition = !step.selected
        ? "Not selected"
        : step.skipReason === "dry-run"
          ? "Dry-run skip"
          : step.skipReason
            ? "Skipped"
            : "Will run";
      const detail =
        step.description ||
        (step.dependencies.length
          ? "After " + step.dependencies.join(", ")
          : "No required dependencies");
      const nested = step.nestedPipeline;
      const remote = step.remote;
      const kind = remote
        ? "Remote step"
        : nested
          ? nested.mode === "for-each"
            ? "Pipeline fan-out"
            : "Nested pipeline"
          : "Step";
      const nestedDetail = nested
        ? '<div class="plan-nested"><strong>' +
          escapeHtml(nested.pipelineId) +
          "</strong><span>" +
          nested.stepIds.length +
          " declared steps" +
          (nested.mode === "for-each" ? " per runtime item" : "") +
          "</span>" +
          nested.stepIds.map((stepId) => "<code>" + escapeHtml(stepId) + "</code>").join("") +
          "</div>"
        : "";
      const remoteDetail = remote
        ? '<div class="plan-nested"><strong>' +
          escapeHtml(remote.engine) +
          "</strong>" +
          (remote.target ? "<span>" + escapeHtml(remote.target) + "</span>" : "") +
          "</div>"
        : "";
      return (
        '<div class="plan-step"><div class="plan-step-title"><strong>' +
        escapeHtml(step.name || step.id) +
        '</strong><span class="plan-kind' +
        (nested ? " pipeline" : "") +
        '">' +
        kind +
        "</span></div><small>" +
        escapeHtml(detail) +
        '</small><span class="plan-disposition' +
        (disposition === "Will run" ? "" : " skipped") +
        '">' +
        disposition +
        "</span>" +
        nestedDetail +
        remoteDetail +
        "</div>"
      );
    })
    .join("");
  return (
    errors +
    '<div class="plan-summary"><strong>' +
    escapeHtml(plan.pipelineId) +
    "</strong><span>" +
    selected +
    " of " +
    plan.steps.length +
    " steps will run" +
    (plan.dryRun ? " · dry run" : "") +
    '</span></div><div class="plan-steps">' +
    steps +
    "</div>"
  );
}
