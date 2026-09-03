import type { CliParameterDescriptor } from "./cli.js";
import type { PipelinePlan, PipelineRunControls } from "./pipeline.js";
import type {
  PipelineRunStudioCommand,
  PipelineRunStudioLaunchRequest,
} from "./run-store-ui-protocol.js";
import type {
  PipelineRunStoreSnapshot,
  StoredPipelineRun,
  StoredPipelineStep,
} from "./run-store.js";

interface StudioNode extends HTMLElement {
  checked: boolean;
  disabled: boolean;
  options: HTMLOptionsCollection;
  placeholder: string;
  selectedOptions: HTMLCollectionOf<HTMLOptionElement>;
  value: string;
}

interface StudioSnapshot extends PipelineRunStoreSnapshot {
  liveRunIds?: readonly string[];
}

interface StudioRunDetail {
  run: StoredPipelineRun;
}

interface StudioState {
  canCancel: boolean;
  canClearHistory: boolean;
  cancelling: boolean;
  clearing: boolean;
  commands: PipelineRunStudioCommand[];
  detail: StudioRunDetail | null;
  detailFingerprint: string | null;
  launching: boolean;
  loading: boolean;
  planning: boolean;
  planVersion: number;
  query: string;
  selectedRunId: string | null;
  snapshot: StudioSnapshot | null;
  view: string;
}

/** Browser client for the local studio page. Compiled JS is inlined into the served HTML. */
export function initStudio(): void {
  const state: StudioState = {
    snapshot: null,
    detail: null,
    detailFingerprint: null,
    commands: [],
    view: "runs",
    selectedRunId: null,
    query: "",
    loading: false,
    launching: false,
    planning: false,
    clearing: false,
    cancelling: false,
    canCancel: false,
    canClearHistory: false,
    planVersion: 0,
  };
  const $ = (selector: string): StudioNode => {
    const node = document.querySelector(selector);
    if (!(node instanceof HTMLElement)) throw new Error("Missing " + selector);
    // SAFETY: Studio markup uses HTML elements that expose value/checked/disabled.
    return node as StudioNode;
  };
  const nodes = (selector: string): StudioNode[] =>
    Array.from(document.querySelectorAll(selector), (node) => {
      // SAFETY: Studio event selectors only match HTML elements on this page.
      return node as StudioNode;
    });
  const queryNode = (selector: string): StudioNode | null => {
    const node = document.querySelector(selector);
    if (!(node instanceof HTMLElement)) return null;
    // SAFETY: Parameter controls in the launch form are HTML inputs, selects, or textareas.
    return node as StudioNode;
  };
  function setConnected(connected: boolean) {
    $("#connectionLabel").textContent = connected ? "Connected · local" : "Connection lost";
    $(".pulse").classList.toggle("lost", !connected);
  }
  const esc = (value: string | number | boolean | null | undefined) =>
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
  const statusMark = (value: string) =>
    value === "completed"
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
  const status = (value: string) =>
    '<span class="status ' +
    esc(value) +
    '"><i class="status-mark" aria-hidden="true">' +
    statusMark(value) +
    "</i>" +
    esc(value) +
    "</span>";
  const duration = (ms: number | null | undefined) =>
    ms == null
      ? "—"
      : ms < 1000
        ? Math.max(0, Math.round(ms)) + " ms"
        : ms < 60000
          ? (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + " s"
          : Math.floor(ms / 60000) + "m " + Math.round((ms % 60000) / 1000) + "s";
  const clock = (ms: number) => {
    if (!Number.isFinite(ms) || Math.abs(ms) > 8.64e15) return "";
    return new Intl.DateTimeFormat(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).format(ms);
  };
  const dateTime = (ms: number) => {
    if (!Number.isFinite(ms) || Math.abs(ms) > 8.64e15) return "";
    return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" }).format(
      ms
    );
  };
  const isoTime = (ms: number) => {
    if (!Number.isFinite(ms) || Math.abs(ms) > 8.64e15) return "";
    return new Date(ms).toISOString();
  };
  const relative = (ms: number) => {
    const delta = Math.max(0, Date.now() - ms);
    if (delta < 60000) return Math.floor(delta / 1000) + "s ago";
    if (delta < 3600000) return Math.floor(delta / 60000) + "m ago";
    if (delta < 86400000) return Math.floor(delta / 3600000) + "h ago";
    return Math.floor(delta / 86400000) + "d ago";
  };
  const shortId = (id: string) => (id.length > 24 ? id.slice(0, 12) + "…" + id.slice(-7) : id);
  function selectedCommand(): PipelineRunStudioCommand | undefined {
    return state.commands.find((command) => command.id === $("#launchCommand").value);
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
        esc(labelText) +
        "</strong><small>" +
        esc(hint || "Enable this option.") +
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
      esc(labelText) +
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
            esc(choice) +
            '"' +
            (choice === parameter.default ? " selected" : "") +
            ">" +
            esc(choice) +
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
            (parameter.min === undefined ? "" : ' min="' + esc(parameter.min) + '"') +
            (parameter.max === undefined ? "" : ' max="' + esc(parameter.max) + '"')
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
        esc(value) +
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
      (hint ? '<div class="field-hint">' + esc(hint) + "</div>" : "") +
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
  function bindExclusiveSelections(command: PipelineRunStudioCommand, scope: string) {
    const fields = command.parameters.flatMap((parameter, index) => {
      if (!parameter.exclusive || !parameter.multiple) return [];
      const field = queryNode("[data-" + scope + '-parameter-index="' + index + '"]');
      return field ? [field] : [];
    });
    const clear = (field: StudioNode) => {
      if (field.tagName === "SELECT")
        Array.from(field.options).forEach((option) => {
          option.selected = false;
        });
      else field.value = "";
    };
    fields.forEach((field) => {
      field.addEventListener("change", () => {
        if (field.selectedOptions?.length || field.value) {
          fields.forEach((other) => {
            if (other !== field) clear(other);
          });
        }
      });
    });
  }
  function renderCommandForm() {
    const command = selectedCommand();
    $("#launchTitle").textContent = command?.name || "Run a pipeline";
    $("#launchDescription").textContent = command
      ? commandDescription(command)
      : "Choose a declared pipeline and provide its inputs.";
    if (!command) {
      $("#parameterFields").innerHTML = "";
      $("#previewPlan").classList.add("hidden");
      return;
    }
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
    $("#parameterFields").innerHTML =
      section(
        "Pipeline inputs",
        domainKeys.size + " parameter" + (domainKeys.size === 1 ? "" : "s"),
        domainKeys
      ) + section("Execution controls", "Built into Tubeless", executionKeys);
    bindExclusiveSelections(command, "run");
    $("#previewPlan").classList.toggle("hidden", !command.canPlan);
    invalidatePlan();
  }
  function parameterValues(parameter: CliParameterDescriptor, index: number, scope: string) {
    const control = queryNode("[data-" + scope + '-parameter-index="' + index + '"]');
    if (!control) return [];
    if (parameter.type === "boolean") return [control.checked];
    const rawValues = parameter.multiple
      ? control.tagName === "SELECT"
        ? Array.from(control.selectedOptions).map((option) => option.value)
        : control.value
            .split(/\r?\n/)
            .map((value) => value.trim())
            .filter(Boolean)
      : [control.value];
    return parameter.type === "number"
      ? rawValues.map((value) => (value === "" ? value : Number(value)))
      : rawValues;
  }
  function parameterLaunchValues(command: PipelineRunStudioCommand) {
    const values: PipelineRunStudioLaunchRequest["values"] = {};
    command.parameters.forEach((parameter, index) => {
      const parameterValue = parameterValues(parameter, index, "run");
      if (parameter.type === "boolean") {
        const checked = parameterValue[0];
        if (checked !== Boolean(parameter.default)) values[parameter.key] = checked;
        return;
      }
      if (parameter.multiple) {
        values[parameter.key] =
          parameter.type === "number"
            ? parameterValue.filter((value): value is number => typeof value === "number")
            : parameterValue.filter((value): value is string => typeof value === "string");
        return;
      }
      const single = parameterValue[0];
      if (single !== "" && single !== undefined) values[parameter.key] = single;
    });
    return values;
  }
  function currentPlanInput(command: PipelineRunStudioCommand): PipelineRunControls {
    const input: Record<string, boolean | readonly string[]> = {};
    command.parameters.forEach((parameter, index) => {
      if (parameter.group !== "execution") return;
      const values = parameterValues(parameter, index, "run");
      if (parameter.type === "boolean") {
        if (values[0] === true) input[parameter.key] = true;
        return;
      }
      if (parameter.multiple && values.length) {
        input[parameter.key] = values.filter((value): value is string => typeof value === "string");
      }
    });
    // SAFETY: Execution controls are plan selections; the server parser ignores unknown keys.
    return input as PipelineRunControls;
  }
  function invalidatePlan() {
    state.planVersion += 1;
    $("#planResult").classList.add("hidden");
    $("#planResult").innerHTML = "";
  }
  function showLaunchError(message: string) {
    $("#launchError").textContent = message;
    $("#launchError").classList.toggle("hidden", !message);
  }
  function closeLaunch() {
    if (state.launching || state.planning) return;
    $("#launchModal").classList.add("hidden");
    showLaunchError("");
  }
  function openLaunch(commandId?: string) {
    if (commandId) $("#launchCommand").value = commandId;
    $("#launchModal").classList.remove("hidden");
    renderCommandForm();
    const firstField = $("#parameterFields").querySelector("input, select, textarea");
    if (firstField instanceof HTMLElement) firstField.focus();
  }
  function showToast(message: string) {
    const toast = $("#toast");
    toast.textContent = message;
    toast.classList.remove("hidden");
    setTimeout(() => toast.classList.add("hidden"), 4200);
  }
  function showClearHistoryError(message: string) {
    $("#clearHistoryError").textContent = message;
    $("#clearHistoryError").classList.toggle("hidden", !message);
  }
  function closeClearHistory() {
    if (state.clearing) return;
    $("#clearHistoryModal").classList.add("hidden");
    showClearHistoryError("");
  }
  function openClearHistory() {
    if (!state.canClearHistory) return;
    const runCount = state.snapshot?.runs.length ?? 0;
    const eventCount = state.snapshot?.runs.reduce((total, run) => total + run.eventCount, 0) ?? 0;
    const activeRunCount = state.snapshot?.activeRunCount ?? 0;
    $("#clearHistoryCopy").textContent =
      "Remove " +
      runCount +
      " recorded run" +
      (runCount === 1 ? "" : "s") +
      " and " +
      eventCount +
      " event" +
      (eventCount === 1 ? "" : "s") +
      " from this SQLite store." +
      (activeRunCount
        ? " " +
          activeRunCount +
          " recorded run" +
          (activeRunCount === 1 ? " is" : "s are") +
          " still marked active; continue only if no external process is writing to this store."
        : "");
    $("#clearHistoryModal").classList.remove("hidden");
    $("#confirmClearHistory").focus();
  }
  async function clearHistory() {
    if (state.clearing) return;
    state.clearing = true;
    const button = $("#confirmClearHistory");
    button.disabled = true;
    button.textContent = "Clearing…";
    showClearHistoryError("");
    try {
      const response = await fetch("/api/history", {
        method: "DELETE",
        headers: { "x-tubeless-studio-clear-history": "1" },
      });
      const result = await response.json();
      if (!response.ok || !result.cleared)
        throw new Error(result.error || "History could not be cleared.");
      state.selectedRunId = null;
      $("#clearHistoryModal").classList.add("hidden");
      showToast(
        "Cleared " + result.eventCount + " recorded event" + (result.eventCount === 1 ? "" : "s")
      );
      await refresh(true);
    } catch (error) {
      showClearHistoryError(
        error instanceof Error ? error.message || String(error) : String(error)
      );
    } finally {
      state.clearing = false;
      button.disabled = false;
      button.textContent = "Clear history";
    }
  }
  function metrics(snapshot: StudioSnapshot) {
    const terminal = snapshot.completedRunCount + snapshot.failedRunCount;
    const success = terminal ? Math.round((snapshot.completedRunCount / terminal) * 100) : 0;
    const pipelineCount = state.commands.length || snapshot.definitions.length;
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
        state.commands.length ? "Available to configure" : "Observed in run history",
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
  function empty(title: string, copy: string) {
    return (
      '<div class="empty"><div><div class="empty-icon"><svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M4 5.5h12M4 10h12M4 14.5h8"/></svg></div><strong>' +
      esc(title) +
      "</strong><p>" +
      esc(copy) +
      "</p></div></div>"
    );
  }
  function commandDescription(command: PipelineRunStudioCommand) {
    return command.description || "Run this typed pipeline command.";
  }
  function commandCatalog(commands: readonly PipelineRunStudioCommand[]) {
    return (
      '<section class="sheet"><div class="sheet-head"><div><div class="sheet-title">Available pipelines</div><div class="sheet-subtitle">Declared by the local studio manifest</div></div><span class="sheet-subtitle">' +
      commands.length +
      ' shown</span></div><div class="catalog">' +
      commands
        .map(
          (command) =>
            '<article class="catalog-card"><h3>' +
            esc(command.name) +
            "</h3><p>" +
            esc(commandDescription(command)) +
            '</p><div class="catalog-actions"><button class="primary-button" data-command-id="' +
            esc(command.id) +
            '">Configure</button></div></article>'
        )
        .join("") +
      "</div></section>"
    );
  }
  function runRow(run: StoredPipelineRun) {
    const activeStep = run.steps.find((step) => step.status === "running");
    const nestedCount = descendantsOf(run.runId).length;
    const activity =
      run.status === "running"
        ? '<div class="run-activity"><strong>' +
          esc(activeStep?.name || activeStep?.id || "Starting") +
          "</strong><span>" +
          esc(activeStep?.progress?.message || "Execution in progress") +
          "</span></div>"
        : "";
    return (
      '<button class="run-row ' +
      esc(run.status) +
      " " +
      (rootRunId(state.selectedRunId) === run.runId ? "selected" : "") +
      '" data-run-id="' +
      esc(run.runId) +
      '"><div class="run-primary">' +
      status(run.status) +
      "<strong>" +
      esc(run.pipelineId) +
      '</strong><time class="run-time" datetime="' +
      isoTime(run.startedAtMs) +
      '" title="' +
      esc(dateTime(run.startedAtMs)) +
      '">' +
      relative(run.startedAtMs) +
      '</time></div><div class="run-secondary"><code>' +
      esc(shortId(run.runId)) +
      '</code><i class="dot"></i><span>' +
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
  function stepRow(step: StoredPipelineStep) {
    const progressTotal = step.progress?.total;
    const progressWidth = progressTotal
      ? Math.max(0, Math.min(100, ((step.progress?.completed ?? 0) / progressTotal) * 100))
      : step.status === "completed"
        ? 100
        : 18;
    const execution = step.attempt
      ? '<span class="execution-summary" title="' +
        esc(step.attempt.attemptId) +
        '"><b>Execution</b> · ' +
        esc(shortId(step.attempt.attemptId)) +
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
        esc(nested.pipelineId) +
        "</strong><span>" +
        nestedCountLabel +
        (nested.mode === "for-each" ? " per runtime item" : "") +
        "</span>" +
        nested.stepIds.map((stepId) => "<code>" + esc(stepId) + "</code>").join("") +
        "</div>"
      : "";
    const remoteDetail = remote
      ? '<div class="plan-nested"><strong>' +
        esc(remote.engine) +
        "</strong>" +
        (remote.target ? "<span>" + esc(remote.target) + "</span>" : "") +
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
              esc(detail.status || "running") +
              '"><b>' +
              esc(detail.id) +
              "</b>" +
              (detail.label ? "<span>" + esc(detail.label) + "</span>" : "") +
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
        esc(
          step.progress.message ||
            step.progress.completed + (progressTotal ? " / " + progressTotal : "") + " complete"
        ) +
        "</div>" +
        detailRows
      : "";
    return (
      '<article class="step ' +
      esc(step.status) +
      '">' +
      stepStatusIcon(step.status) +
      '<div class="step-head"><strong>' +
      esc(step.name || step.id) +
      "</strong>" +
      (step.name ? "<code>" + esc(step.id) + "</code>" : "") +
      '<span class="step-duration">' +
      duration(step.durationMs) +
      "</span></div>" +
      (step.description
        ? '<div class="step-description">' + esc(step.description) + "</div>"
        : "") +
      nestedDetail +
      remoteDetail +
      (execution ? '<div class="execution">' + execution + "</div>" : "") +
      progress +
      "</article>"
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
      esc(value) +
      '" role="img" aria-label="' +
      esc(label) +
      '" title="' +
      esc(label) +
      '">' +
      icon +
      "</span>"
    );
  }
  function stepSummary(run: StoredPipelineRun) {
    const labels = {
      running: "running",
      failed: "failed",
      cancelled: "cancelled",
      skipped: "skipped",
      completed: "completed",
      planned: "planned",
    } as const;
    const order = ["running", "failed", "cancelled", "skipped", "completed", "planned"] as const;
    return (
      order
        .map((value) => [value, run.steps.filter((step) => step.status === value).length] as const)
        .filter(([, count]) => count)
        .map(([value, count]) => count + " " + labels[value])
        .join(" · ") || "No steps"
    );
  }
  function runDetail(run: StoredPipelineRun | null) {
    if (!run)
      return (
        '<div class="sheet detail">' +
        empty(
          "Select a run",
          "Choose a run from the history to inspect its steps, retry telemetry, logs, and errors."
        ) +
        "</div>"
      );
    const ancestors = ancestorsOf(run.runId);
    const parentage = ancestors.length
      ? '<div class="run-parentage">' +
        ancestors
          .map(
            (ancestor) =>
              '<button type="button" data-detail-run-id="' +
              esc(ancestor.runId) +
              '">' +
              esc(ancestor.pipelineId) +
              "</button><span>/</span>"
          )
          .join("") +
        "<span>" +
        esc(run.pipelineId) +
        "</span></div>"
      : "";
    const children = childrenOf(run.runId);
    const nested = children.length
      ? '<div class="section-title"><span>Nested runs</span><span>' +
        children.length +
        " direct · " +
        descendantsOf(run.runId).length +
        ' total</span></div><div class="nested-runs">' +
        children
          .map(
            (child) =>
              '<button class="nested-run" type="button" data-detail-run-id="' +
              esc(child.runId) +
              '">' +
              status(child.status) +
              "<strong>" +
              esc(child.pipelineId) +
              "</strong><small>" +
              duration(child.durationMs) +
              " · " +
              child.steps.length +
              " steps" +
              (descendantsOf(child.runId).length
                ? " · " + descendantsOf(child.runId).length + " nested"
                : "") +
              "</small></button>"
          )
          .join("") +
        "</div>"
      : "";
    const error = run.error
      ? '<div class="section-title"><span>Error</span></div><div class="error-card"><div class="error-code">' +
        esc(run.error.code) +
        " · " +
        esc(run.error.phase) +
        '</div><div class="error-message">' +
        esc(run.error.message) +
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
              esc(log.level) +
              '">' +
              esc(log.level) +
              '</span><span class="log-message">' +
              (log.stepId ? "<b>" + esc(log.stepId) + "</b> · " : "") +
              esc(log.message) +
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
      relative(run.startedAtMs) +
      "</div><h2>" +
      esc(run.pipelineId) +
      '</h2><div class="run-id">' +
      esc(run.runId) +
      '</div></div><div class="detail-heading-actions">' +
      status(run.status) +
      (state.canCancel &&
      run.status === "running" &&
      !run.parentRunId &&
      Array.isArray(state.snapshot?.liveRunIds) &&
      state.snapshot.liveRunIds.includes(run.runId)
        ? '<button class="danger-button" type="button" data-cancel-run-id="' +
          esc(run.runId) +
          '"' +
          (state.cancelling ? " disabled" : "") +
          ">Cancel run</button>"
        : "") +
      '</div></div><div class="detail-meta"><div><label>Started</label><span title="' +
      esc(isoTime(run.startedAtMs)) +
      '">' +
      esc(dateTime(run.startedAtMs)) +
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
        : empty("No planned steps", "This run ended before a step plan was recorded.")) +
      error +
      logs +
      "</div></article>"
    );
  }
  function runById(runId: string | null | undefined) {
    return state.snapshot?.runs.find((run) => run.runId === runId);
  }
  function childrenOf(runId: string): StoredPipelineRun[] {
    return (state.snapshot?.runs ?? [])
      .filter((run) => run.parentRunId === runId)
      .sort((left, right) => right.startedAtMs - left.startedAtMs);
  }
  function descendantsOf(runId: string, seen: Set<string> = new Set()): StoredPipelineRun[] {
    if (seen.has(runId)) return [];
    seen.add(runId);
    return childrenOf(runId)
      .filter((child) => !seen.has(child.runId))
      .flatMap((child) => [child, ...descendantsOf(child.runId, seen)]);
  }
  function ancestorsOf(runId: string | null | undefined) {
    const ancestors: StoredPipelineRun[] = [];
    const seen = new Set<string>();
    let current = runById(runId);
    while (current?.parentRunId && !seen.has(current.parentRunId)) {
      seen.add(current.parentRunId);
      const parent = runById(current.parentRunId);
      if (!parent) break;
      ancestors.unshift(parent);
      current = parent;
    }
    return ancestors;
  }
  function rootRunId(runId: string | null | undefined) {
    return ancestorsOf(runId).at(0)?.runId || runId;
  }
  function renderRuns() {
    const query = state.query.toLowerCase();
    const roots = (state.snapshot?.runs ?? [])
      .filter((run) => !run.parentRunId || !runById(run.parentRunId))
      .filter(
        (run) =>
          !query ||
          [run, ...descendantsOf(run.runId)].some(
            (candidate) =>
              candidate.pipelineId.toLowerCase().includes(query) ||
              candidate.runId.toLowerCase().includes(query)
          )
      )
      .sort(
        (left, right) =>
          Number([right, ...descendantsOf(right.runId)].some((run) => run.status === "running")) -
            Number([left, ...descendantsOf(left.runId)].some((run) => run.status === "running")) ||
          right.startedAtMs - left.startedAtMs
      );
    if (!state.selectedRunId || !roots.some((run) => run.runId === rootRunId(state.selectedRunId)))
      state.selectedRunId = roots[0]?.runId ?? null;
    const selected = state.detail?.run?.runId === state.selectedRunId ? state.detail.run : null;
    const activeRuns = roots.filter((root) =>
      [root, ...descendantsOf(root.runId)].some((run) => run.status === "running")
    );
    const historicalRuns = roots.filter((root) => !activeRuns.includes(root));
    const activeList = activeRuns.length
      ? '<div class="run-group">Running now · ' +
        activeRuns.length +
        "</div>" +
        activeRuns.map(runRow).join("")
      : "";
    const historyList = historicalRuns.length
      ? '<div class="run-group">Recent · ' +
        historicalRuns.length +
        "</div>" +
        historicalRuns.map(runRow).join("")
      : "";
    $("#content").innerHTML =
      '<div class="content-grid"><section class="sheet"><div class="sheet-head"><div><div class="sheet-title">Pipeline runs</div><div class="sheet-subtitle">Top-level runs · nested work stays with its parent</div></div><span class="sheet-subtitle">' +
      roots.length +
      " top-level · " +
      (state.snapshot?.runs.length ?? 0) +
      ' total</span></div><div class="run-list">' +
      (roots.length
        ? activeList + historyList
        : empty("No recorded runs", "Choose Pipelines to start a run and create local history.")) +
      "</div></section>" +
      runDetail(selected) +
      "</div>";
    nodes("[data-run-id]").forEach((button) =>
      button.addEventListener("click", () => {
        void selectRun(button.dataset.runId);
      })
    );
    nodes("[data-detail-run-id]").forEach((button) =>
      button.addEventListener("click", () => {
        void selectRun(button.dataset.detailRunId);
      })
    );
    nodes("[data-cancel-run-id]").forEach((button) =>
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        void cancelRun(button.dataset.cancelRunId);
      })
    );
  }
  function renderPipelines() {
    const query = state.query.toLowerCase();
    const commands = state.commands.filter(
      (command) =>
        !query ||
        command.name.toLowerCase().includes(query) ||
        commandDescription(command).toLowerCase().includes(query)
    );
    $("#content").innerHTML = commands.length
      ? commandCatalog(commands)
      : '<div class="sheet">' +
        empty("No pipelines found", "Try a different pipeline name or description.") +
        "</div>";
    nodes("[data-command-id]").forEach((button) =>
      button.addEventListener("click", () => openLaunch(button.dataset.commandId))
    );
  }
  function render() {
    if (!state.snapshot) return;
    const isPipelines = state.view === "pipelines";
    $("#pageTitle").textContent = isPipelines ? "Pipelines" : "Runs";
    $("#pageLede").textContent = isPipelines
      ? "Choose a declared workflow to configure and run."
      : "Live work and durable history in one place.";
    $("#search").placeholder = isPipelines ? "Filter pipelines" : "Filter runs or IDs";
    $("#metrics").innerHTML = metrics(state.snapshot);
    $("#pipelineCount").textContent = String(state.commands.length);
    $("#runCount").textContent = String(state.snapshot.runs.length);
    $("#clearHistoryButton").disabled = state.snapshot.runs.length === 0;
    $("#clearHistoryButton").title =
      state.snapshot.activeRunCount > 0
        ? "Clear history, including runs left active by an interrupted process"
        : "Clear history";
    nodes("[data-view]").forEach((button) =>
      button.classList.toggle("active", button.dataset.view === state.view)
    );
    if (isPipelines) renderPipelines();
    else renderRuns();
  }
  function selectedRunFingerprint() {
    const run =
      state.snapshot && state.snapshot.runs.find((item) => item.runId === state.selectedRunId);
    return run ? [run.runId, run.eventCount, run.status].join(":") : null;
  }
  async function loadSelectedRunDetail() {
    if (!state.selectedRunId) {
      state.detail = null;
      state.detailFingerprint = null;
      return;
    }
    const requestedRunId = state.selectedRunId;
    const fingerprint = selectedRunFingerprint();
    if (!fingerprint) {
      state.detail = null;
      state.detailFingerprint = null;
      return;
    }
    if (fingerprint === state.detailFingerprint && state.detail) return;
    const response = await fetch("/api/runs/" + encodeURIComponent(requestedRunId), {
      cache: "no-store",
    });
    if (state.selectedRunId !== requestedRunId) return;
    if (response.status === 404) {
      state.detail = null;
      state.detailFingerprint = null;
      return;
    }
    if (!response.ok) return;
    // SAFETY: The run detail endpoint returns `{ run }` for the requested id.
    const detail = (await response.json()) as StudioRunDetail;
    if (state.selectedRunId !== requestedRunId) return;
    state.detail = detail;
    state.detailFingerprint = fingerprint;
  }
  async function selectRun(runId: string | undefined) {
    state.selectedRunId = runId ?? null;
    render();
    await loadSelectedRunDetail();
    render();
  }
  async function refresh(manual = false) {
    if (state.loading) return;
    state.loading = true;
    if (manual) $("#refresh").classList.add("spinning");
    try {
      const response = await fetch("/api/snapshot", { cache: "no-store" });
      if (!response.ok) throw new Error("Snapshot request failed");
      state.snapshot = await response.json();
      render();
      await loadSelectedRunDetail();
      setConnected(true);
      render();
    } catch {
      /* Snapshot fetch failed; keep the last rendered run list and mark the connection lost. */
      setConnected(false);
    } finally {
      state.loading = false;
      $("#refresh").classList.remove("spinning");
    }
  }
  async function loadCommands() {
    try {
      const response = await fetch("/api/commands", { cache: "no-store" });
      if (!response.ok) return;
      const payload = await response.json();
      state.commands = Array.isArray(payload.commands) ? payload.commands : [];
      $("#pipelineNav").classList.toggle("hidden", state.commands.length === 0);
      $("#launchButton").classList.toggle("hidden", state.commands.length === 0);
      $("#launchCommand").innerHTML = state.commands
        .map(
          (command) => '<option value="' + esc(command.id) + '">' + esc(command.name) + "</option>"
        )
        .join("");
      if (state.commands.length > 0) state.view = "pipelines";
      renderCommandForm();
      render();
    } catch {
      /* Optional studio endpoints; keep the last successful client state. */
    }
  }
  async function loadCapabilities() {
    try {
      const response = await fetch("/api/capabilities", { cache: "no-store" });
      if (!response.ok) return;
      const capabilities = await response.json();
      state.canClearHistory = capabilities.canClearHistory === true;
      state.canCancel = capabilities.canCancel === true;
      $("#clearHistoryButton").classList.toggle("hidden", !state.canClearHistory);
      render();
    } catch {
      /* Optional studio endpoints; keep the last successful client state. */
    }
  }
  function renderPlan(plan: PipelinePlan) {
    const selected = plan.steps.filter((step) => step.selected && !step.skipReason).length;
    const errors = plan.errors.length
      ? '<div class="launch-error">' +
        plan.errors.map((error) => esc(error.message)).join("<br>") +
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
            esc(nested.pipelineId) +
            "</strong><span>" +
            nested.stepIds.length +
            " declared steps" +
            (nested.mode === "for-each" ? " per runtime item" : "") +
            "</span>" +
            nested.stepIds.map((stepId) => "<code>" + esc(stepId) + "</code>").join("") +
            "</div>"
          : "";
        const remoteDetail = remote
          ? '<div class="plan-nested"><strong>' +
            esc(remote.engine) +
            "</strong>" +
            (remote.target ? "<span>" + esc(remote.target) + "</span>" : "") +
            "</div>"
          : "";
        return (
          '<div class="plan-step"><div class="plan-step-title"><strong>' +
          esc(step.name || step.id) +
          '</strong><span class="plan-kind' +
          (nested ? " pipeline" : "") +
          '">' +
          kind +
          "</span></div><small>" +
          esc(detail) +
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
    $("#planResult").innerHTML =
      errors +
      '<div class="plan-summary"><strong>' +
      esc(plan.pipelineId) +
      "</strong><span>" +
      selected +
      " of " +
      plan.steps.length +
      " steps will run" +
      (plan.dryRun ? " · dry run" : "") +
      '</span></div><div class="plan-steps">' +
      steps +
      "</div>";
    $("#planResult").classList.remove("hidden");
  }
  async function previewPlan() {
    const command = selectedCommand();
    if (!command?.canPlan || state.planning) return;
    state.planning = true;
    const planVersion = state.planVersion;
    $("#previewPlan").disabled = true;
    $("#previewPlan").textContent = "Planning…";
    $("#submitLaunch").disabled = true;
    showLaunchError("");
    try {
      const response = await fetch("/api/commands/" + encodeURIComponent(command.id) + "/plan", {
        method: "POST",
        headers: { "content-type": "application/json", "x-tubeless-studio-plan": "1" },
        body: JSON.stringify(currentPlanInput(command)),
      });
      const result = await response.json();
      if (!response.ok || !result.plan) throw new Error(result.error || "Plan request failed.");
      if (state.planVersion === planVersion) renderPlan(result.plan);
    } catch (error) {
      showLaunchError(error instanceof Error ? error.message || String(error) : String(error));
    } finally {
      state.planning = false;
      $("#previewPlan").disabled = false;
      $("#previewPlan").textContent = "Preview plan";
      $("#submitLaunch").disabled = false;
    }
  }
  async function cancelRun(runId: string | undefined) {
    if (!state.canCancel || !runId || state.cancelling) return;
    state.cancelling = true;
    render();
    try {
      const response = await fetch("/api/runs/" + encodeURIComponent(runId) + "/cancel", {
        method: "POST",
        headers: { "x-tubeless-studio-cancel": "1" },
      });
      const result = await response.json();
      if (!response.ok || !result.cancelled)
        throw new Error(result.error || "Run could not be cancelled.");
      showToast("Run cancelled · " + shortId(runId));
      setTimeout(() => refresh(true), 80);
    } catch (error) {
      showToast(error instanceof Error ? error.message || String(error) : String(error));
    } finally {
      state.cancelling = false;
      render();
    }
  }
  async function launch(event: Event) {
    event.preventDefault();
    const command = selectedCommand();
    if (!command || state.launching) return;
    const values = parameterLaunchValues(command);
    state.launching = true;
    $("#previewPlan").disabled = true;
    $("#submitLaunch").disabled = true;
    $("#submitLaunch").textContent = "Starting…";
    showLaunchError("");
    try {
      const response = await fetch("/api/commands/" + encodeURIComponent(command.id) + "/runs", {
        method: "POST",
        headers: { "content-type": "application/json", "x-tubeless-studio-launch": "1" },
        body: JSON.stringify({ values }),
      });
      const result = await response.json();
      if (!response.ok || !result.accepted)
        throw new Error((result.errors || [result.error || "Launch failed."]).join("\n"));
      state.selectedRunId = result.runId;
      state.view = "runs";
      $("#launchModal").classList.add("hidden");
      renderCommandForm();
      showToast("Run accepted · " + shortId(result.runId));
      setTimeout(() => refresh(true), 80);
    } catch (error) {
      showLaunchError(error instanceof Error ? error.message || String(error) : String(error));
    } finally {
      state.launching = false;
      $("#previewPlan").disabled = false;
      $("#submitLaunch").disabled = false;
      $("#submitLaunch").textContent = "Run";
    }
  }
  nodes("[data-view]").forEach((button) =>
    button.addEventListener("click", () => {
      state.view = button.dataset.view ?? state.view;
      render();
    })
  );
  $("#search").addEventListener("input", (event: Event) => {
    const target = event.target;
    if (target instanceof HTMLInputElement) {
      state.query = target.value.trim();
      render();
    }
  });
  $("#refresh").addEventListener("click", () => refresh(true));
  $("#launchButton").addEventListener("click", () => openLaunch());
  $("#clearHistoryButton").addEventListener("click", openClearHistory);
  $("#confirmClearHistory").addEventListener("click", clearHistory);
  $("#closeClearHistory").addEventListener("click", closeClearHistory);
  $("#cancelClearHistory").addEventListener("click", closeClearHistory);
  $("#previewPlan").addEventListener("click", previewPlan);
  $("#closeLaunch").addEventListener("click", closeLaunch);
  $("#cancelLaunch").addEventListener("click", closeLaunch);
  $("#launchCommand").addEventListener("change", renderCommandForm);
  $("#runPane").addEventListener("input", invalidatePlan);
  $("#launchForm").addEventListener("submit", launch);
  $("#launchModal").addEventListener("click", (event: Event) => {
    if (event.target === $("#launchModal")) closeLaunch();
  });
  $("#clearHistoryModal").addEventListener("click", (event: Event) => {
    if (event.target === $("#clearHistoryModal")) closeClearHistory();
  });
  document.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      closeLaunch();
      closeClearHistory();
    }
  });
  loadCommands();
  loadCapabilities();
  refresh();
  setInterval(() => refresh(), 1200);
}
