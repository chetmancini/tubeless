import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { commandDescription, PipelinesView } from "./run-store-ui-client-commands.js";
import {
  createStudioRunIndex,
  type StudioRunDetail,
  type StudioSnapshot,
} from "./run-store-ui-client-model.js";
import { Metrics, RunsView } from "./run-store-ui-client-runs.js";
import { ClearHistoryModal, errorMessage, LaunchModal } from "./run-store-ui-client-modals.js";
import { shortId } from "./run-store-ui-client-shared.js";
import { createStudioApi, type StudioApi } from "./run-store-ui-client-transport.js";
import type { PipelineRunStudioCommand } from "./run-store-ui-protocol.js";

type StudioView = "pipelines" | "runs";
const defaultStudioApi = createStudioApi();

export function connectionPresentation(connected: boolean) {
  return {
    className: `pulse${connected ? "" : " lost"}`,
    label: connected ? "Connected · local" : "Connection lost",
  };
}

export function StudioApp({ api = defaultStudioApi }: { api?: StudioApi }) {
  const [snapshot, setSnapshot] = useState<StudioSnapshot | null>(null);
  const [commands, setCommands] = useState<PipelineRunStudioCommand[]>([]);
  const [view, setView] = useState<StudioView>("runs");
  const [query, setQuery] = useState("");
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [detail, setDetail] = useState<StudioRunDetail | null>(null);
  const [detailFingerprint, setDetailFingerprint] = useState<string | null>(null);
  const [connected, setConnected] = useState(true);
  const [manualRefreshing, setManualRefreshing] = useState(false);
  const [canCancel, setCanCancel] = useState(false);
  const [canClearHistory, setCanClearHistory] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [launchCommandId, setLaunchCommandId] = useState<string | null>(null);
  const [clearHistoryOpen, setClearHistoryOpen] = useState(false);
  const [toast, setToast] = useState("");
  const loading = useRef(false);
  const runIndex = useMemo(() => createStudioRunIndex(snapshot?.runs ?? []), [snapshot]);

  const refresh = useCallback(
    async (manual = false) => {
      if (loading.current) return;
      loading.current = true;
      if (manual) setManualRefreshing(true);
      try {
        setSnapshot(await api.loadSnapshot());
        setConnected(true);
      } catch {
        setConnected(false);
      } finally {
        loading.current = false;
        setManualRefreshing(false);
      }
    },
    [api]
  );

  useEffect(() => {
    void api
      .loadCommands()
      .then((loaded) => {
        setCommands(loaded);
        if (loaded.length) setView("pipelines");
      })
      .catch(() => {});
    void api
      .loadCapabilities()
      .then((capabilities) => {
        setCanCancel(capabilities.canCancel);
        setCanClearHistory(capabilities.canClearHistory);
      })
      .catch(() => {});
    void refresh();
    const interval = setInterval(() => void refresh(), 1200);
    return () => clearInterval(interval);
  }, [api, refresh]);

  useEffect(() => {
    if (!toast) return;
    const timeout = setTimeout(() => setToast(""), 4200);
    return () => clearTimeout(timeout);
  }, [toast]);

  const matchedRoots = query ? runIndex.matchingRootIds(query) : null;
  const roots = runIndex.roots
    .filter((run) => !matchedRoots || matchedRoots.has(run.runId))
    .sort(
      (left, right) =>
        Number(runIndex.subtreeIsRunning(right.runId)) -
          Number(runIndex.subtreeIsRunning(left.runId)) || right.startedAtMs - left.startedAtMs
    );

  useEffect(() => {
    if (!selectedRunId || !roots.some((run) => run.runId === runIndex.rootRunId(selectedRunId))) {
      setSelectedRunId(roots[0]?.runId ?? null);
    }
  }, [roots, runIndex, selectedRunId]);

  const selectedSummary = runIndex.runById(selectedRunId);
  const selectedFingerprint = selectedSummary
    ? [selectedSummary.runId, selectedSummary.eventCount, selectedSummary.status].join(":")
    : null;
  useEffect(() => {
    if (!selectedRunId || !selectedFingerprint) {
      setDetail(null);
      setDetailFingerprint(null);
      return;
    }
    if (selectedFingerprint === detailFingerprint && detail) return;
    let current = true;
    void api
      .loadRunDetail(selectedRunId)
      .then((loaded) => {
        if (!current) return;
        setDetail(loaded);
        setDetailFingerprint(loaded ? selectedFingerprint : null);
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [api, detail, detailFingerprint, selectedFingerprint, selectedRunId]);

  const showToast = (message: string) => setToast(message);
  const cancelRun = async (runId: string) => {
    if (!canCancel || cancelling) return;
    setCancelling(true);
    try {
      await api.cancelRun(runId);
      showToast("Run cancelled · " + shortId(runId));
      setTimeout(() => void refresh(true), 80);
    } catch (caught) {
      showToast(errorMessage(caught));
    } finally {
      setCancelling(false);
    }
  };
  const filteredCommands = commands.filter(
    (command) =>
      !query ||
      command.name.toLowerCase().includes(query.toLowerCase()) ||
      commandDescription(command).toLowerCase().includes(query.toLowerCase())
  );
  const isPipelines = view === "pipelines";
  const selectedRun = detail?.run.runId === selectedRunId ? detail.run : null;
  const connection = connectionPresentation(connected);

  return (
    <>
      <div class="shell">
        <aside class="rail">
          <div class="brand">
            <div class="mark" aria-hidden="true">
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
                <path d="M3 4.5h6a3 3 0 0 1 3 3v6" stroke="#f7f8f3" strokeWidth="1.5" />
                <circle cx="3" cy="4.5" r="2" fill="#7396ff" />
                <circle cx="12" cy="13.5" r="2" fill="#63d297" />
              </svg>
            </div>
            <div class="brand-copy">
              <strong>Tubeless</strong>
              <small>Local studio</small>
            </div>
          </div>
          <div class="rail-label">Workspace</div>
          <nav class="nav" aria-label="Studio sections">
            {commands.length > 0 && (
              <button
                class={isPipelines ? "active" : ""}
                type="button"
                title="Pipelines"
                onClick={() => setView("pipelines")}
              >
                <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M4 5h7M4 10h12M9 15h7" />
                  <circle cx="14.5" cy="5" r="1.5" />
                  <circle cx="5.5" cy="15" r="1.5" />
                </svg>
                <span>Pipelines</span>
                <b class="nav-count">{commands.length}</b>
              </button>
            )}
            <button
              class={isPipelines ? "" : "active"}
              type="button"
              title="Runs"
              onClick={() => setView("runs")}
            >
              <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M10 3v4l2.5 1.5M17 10a7 7 0 1 1-2.05-4.95" />
                <path d="M14.5 2.8v3.5H18" />
              </svg>
              <span>Runs</span>
              <b class="nav-count">{snapshot?.runs.length ?? 0}</b>
            </button>
          </nav>
          <div class="rail-foot">
            <div class="connection">
              <i class={connection.className} />
              <span>{connection.label}</span>
            </div>
            <div class="database">append-only SQLite</div>
          </div>
        </aside>
        <main class="workspace">
          <header class="topbar">
            <div>
              <div class="eyebrow">Execution workspace</div>
              <h1>{isPipelines ? "Pipelines" : "Runs"}</h1>
              <p class="lede">
                {isPipelines
                  ? "Choose a declared workflow to configure and run."
                  : "Live work and durable history in one place."}
              </p>
            </div>
            <div class="toolbar">
              <input
                class="search"
                type="search"
                value={query}
                placeholder={isPipelines ? "Filter pipelines" : "Filter runs or IDs"}
                aria-label="Filter"
                onInput={(event) => setQuery(event.currentTarget.value.trim())}
              />
              {commands.length > 0 && (
                <button
                  class="primary-button"
                  onClick={() => setLaunchCommandId(commands[0]?.id ?? "")}
                >
                  Run pipeline
                </button>
              )}
              {canClearHistory && (
                <button
                  class="danger-button"
                  id="clearHistoryButton"
                  type="button"
                  disabled={!snapshot?.runs.length}
                  title={
                    snapshot?.activeRunCount
                      ? "Clear history, including runs left active by an interrupted process"
                      : "Clear history"
                  }
                  onClick={() => setClearHistoryOpen(true)}
                >
                  <svg
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.4"
                    aria-hidden="true"
                  >
                    <path d="M3 4.5h10M6 2.5h4M5 4.5l.5 9h5l.5-9M7 7v4M9 7v4" />
                  </svg>
                  <span>Clear history</span>
                </button>
              )}
              <button
                class={`icon-button${manualRefreshing ? " spinning" : ""}`}
                type="button"
                title="Refresh now"
                aria-label="Refresh now"
                onClick={() => void refresh(true)}
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 20 20"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                >
                  <path d="M16.5 7A7 7 0 1 0 17 11" />
                  <path d="M16.5 3v4h-4" />
                </svg>
              </button>
            </div>
          </header>
          {snapshot && (
            <>
              <section class="metrics">
                <Metrics commandCount={commands.length} snapshot={snapshot} />
              </section>
              <section>
                {isPipelines ? (
                  <PipelinesView commands={filteredCommands} onConfigure={setLaunchCommandId} />
                ) : (
                  <RunsView
                    canCancel={canCancel}
                    cancelling={cancelling}
                    liveRunIds={snapshot.liveRunIds ?? []}
                    nowMs={Date.now()}
                    onCancel={(id) => void cancelRun(id)}
                    onSelect={setSelectedRunId}
                    roots={roots}
                    runIndex={runIndex}
                    selectedRun={selectedRun}
                    selectedRunId={selectedRunId}
                    totalRunCount={snapshot.runs.length}
                  />
                )}
              </section>
            </>
          )}
        </main>
      </div>
      <LaunchModal
        api={api}
        commands={commands}
        commandId={launchCommandId}
        onClose={() => setLaunchCommandId(null)}
        onLaunched={(runId) => {
          setSelectedRunId(runId);
          setView("runs");
          setLaunchCommandId(null);
          showToast("Run accepted · " + shortId(runId));
          setTimeout(() => void refresh(true), 80);
        }}
      />
      {clearHistoryOpen && snapshot && (
        <ClearHistoryModal
          api={api}
          snapshot={snapshot}
          onClose={() => setClearHistoryOpen(false)}
          onCleared={(eventCount) => {
            setSelectedRunId(null);
            setClearHistoryOpen(false);
            showToast("Cleared " + eventCount + " recorded event" + (eventCount === 1 ? "" : "s"));
            void refresh(true);
          }}
        />
      )}
      {toast && (
        <div class="toast" role="status">
          {toast}
        </div>
      )}
    </>
  );
}
