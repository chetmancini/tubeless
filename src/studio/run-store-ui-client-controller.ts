import type { CliParameterDescriptor } from "../cli/cli.js";
import type { PipelinePlan } from "../core/pipeline.js";
import type { PipelineRunStudioCommand } from "./run-store-ui-protocol.js";
import { createStudioRunIndex } from "./run-store-ui-client-model.js";
import type { StudioRunDetail, StudioState } from "./run-store-ui-client-model.js";
import { serializeLaunchValues, serializePlanInput } from "./run-store-ui-client-form.js";
import { createStudioApi } from "./run-store-ui-client-transport.js";
import {
  commandDescription as describeCommand,
  escapeHtml,
  renderCommandFormFields,
  renderMetrics,
  renderPipelinesView,
  renderPlanView,
  renderRunsView,
  shortId as abbreviateId,
} from "./run-store-ui-client-views.js";

interface StudioNode extends HTMLElement {
  checked: boolean;
  disabled: boolean;
  options: HTMLOptionsCollection;
  placeholder: string;
  selectedOptions: HTMLCollectionOf<HTMLOptionElement>;
  value: string;
}

export interface StudioController {
  bind(): void;
  start(): void;
}

function selectedRunFingerprint(state: StudioState) {
  const run = state.runIndex.runById(state.selectedRunId);
  return run ? [run.runId, run.eventCount, run.status].join(":") : null;
}

/** Refresh selected-run detail without allowing its optional endpoint to fail snapshot polling. */
export async function loadSelectedRunDetail(
  state: StudioState,
  loadRunDetail: (runId: string) => Promise<StudioRunDetail | null>
): Promise<void> {
  if (!state.selectedRunId) {
    state.detail = null;
    state.detailFingerprint = null;
    return;
  }
  const requestedRunId = state.selectedRunId;
  const fingerprint = selectedRunFingerprint(state);
  if (!fingerprint) {
    state.detail = null;
    state.detailFingerprint = null;
    return;
  }
  if (fingerprint === state.detailFingerprint && state.detail) return;
  let detail: StudioRunDetail | null;
  try {
    detail = await loadRunDetail(requestedRunId);
  } catch {
    /* Detail is optional; retain the last successful detail and snapshot connection state. */
    return;
  }
  if (state.selectedRunId !== requestedRunId) return;
  if (!detail) {
    state.detail = null;
    state.detailFingerprint = null;
    return;
  }
  state.detail = detail;
  state.detailFingerprint = fingerprint;
}

/** DOM event and polling controller for one Studio client state instance. */
export function createStudioController(state: StudioState): StudioController {
  const api = createStudioApi();
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
  function selectedCommand(): PipelineRunStudioCommand | undefined {
    return state.commands.find((command) => command.id === $("#launchCommand").value);
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
      ? describeCommand(command)
      : "Choose a declared pipeline and provide its inputs.";
    if (!command) {
      $("#parameterFields").innerHTML = "";
      $("#previewPlan").classList.add("hidden");
      return;
    }
    $("#parameterFields").innerHTML = renderCommandFormFields(command);
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
    return serializeLaunchValues(command, (parameter, index) =>
      parameterValues(parameter, index, "run")
    );
  }
  function currentPlanInput(command: PipelineRunStudioCommand) {
    return serializePlanInput(command, (parameter, index) =>
      parameterValues(parameter, index, "run")
    );
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
      const result = await api.clearHistory();
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
  function renderRuns() {
    const matchedRoots = state.query ? state.runIndex.matchingRootIds(state.query) : null;
    const roots = state.runIndex.roots
      .filter((run) => !matchedRoots || matchedRoots.has(run.runId))
      .sort(
        (left, right) =>
          Number(state.runIndex.subtreeIsRunning(right.runId)) -
            Number(state.runIndex.subtreeIsRunning(left.runId)) ||
          right.startedAtMs - left.startedAtMs
      );
    if (
      !state.selectedRunId ||
      !roots.some((run) => run.runId === state.runIndex.rootRunId(state.selectedRunId))
    )
      state.selectedRunId = roots[0]?.runId ?? null;
    const selected = state.detail?.run?.runId === state.selectedRunId ? state.detail.run : null;
    $("#content").innerHTML = renderRunsView({
      canCancel: state.canCancel,
      cancelling: state.cancelling,
      liveRunIds: state.snapshot?.liveRunIds ?? [],
      nowMs: Date.now(),
      roots,
      runIndex: state.runIndex,
      selectedRun: selected,
      selectedRunId: state.selectedRunId,
      totalRunCount: state.snapshot?.runs.length ?? 0,
    });
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
        describeCommand(command).toLowerCase().includes(query)
    );
    $("#content").innerHTML = renderPipelinesView(commands);
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
    $("#metrics").innerHTML = renderMetrics(state.snapshot, state.commands.length);
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
  async function selectRun(runId: string | undefined) {
    state.selectedRunId = runId ?? null;
    render();
    await loadSelectedRunDetail(state, api.loadRunDetail);
    render();
  }
  async function refresh(manual = false) {
    if (state.loading) return;
    state.loading = true;
    if (manual) $("#refresh").classList.add("spinning");
    try {
      const snapshot = await api.loadSnapshot();
      state.snapshot = snapshot;
      state.runIndex = createStudioRunIndex(snapshot.runs);
      render();
      await loadSelectedRunDetail(state, api.loadRunDetail);
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
      state.commands = await api.loadCommands();
      $("#pipelineNav").classList.toggle("hidden", state.commands.length === 0);
      $("#launchButton").classList.toggle("hidden", state.commands.length === 0);
      $("#launchCommand").innerHTML = state.commands
        .map(
          (command) =>
            '<option value="' +
            escapeHtml(command.id) +
            '">' +
            escapeHtml(command.name) +
            "</option>"
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
      const capabilities = await api.loadCapabilities();
      state.canClearHistory = capabilities.canClearHistory;
      state.canCancel = capabilities.canCancel;
      $("#clearHistoryButton").classList.toggle("hidden", !state.canClearHistory);
      render();
    } catch {
      /* Optional studio endpoints; keep the last successful client state. */
    }
  }
  function renderPlan(plan: PipelinePlan) {
    $("#planResult").innerHTML = renderPlanView(plan);
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
      const plan = await api.previewPlan(command.id, currentPlanInput(command));
      if (state.planVersion === planVersion) renderPlan(plan);
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
      await api.cancelRun(runId);
      showToast("Run cancelled · " + abbreviateId(runId));
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
      const runId = await api.launch(command.id, values);
      state.selectedRunId = runId;
      state.view = "runs";
      $("#launchModal").classList.add("hidden");
      renderCommandForm();
      showToast("Run accepted · " + abbreviateId(runId));
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
  return {
    bind() {
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
    },
    start() {
      void loadCommands();
      void loadCapabilities();
      void refresh();
      setInterval(() => void refresh(), 1200);
    },
  };
}
