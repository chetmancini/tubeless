import type { StoredRunSummary } from "../../run-store/run-history.js";
import type { StudioRoute } from "../shared/route.js";
import { RunDetailLoader, DEFAULT_DETAIL_RETRY_MS } from "./run-detail-loader.js";
import type {
  StudioApi,
  StudioAccessDenied,
  StudioRunDetail,
  StudioSnapshot,
} from "./transport.js";

export type StudioRunSelection =
  | { status: "none" }
  | { status: "loading"; runId: string; summary?: StoredRunSummary }
  | { status: "unavailable"; runId: string }
  | { status: "ready"; runId: string; summary: StoredRunSummary; detail: StudioRunDetail };

interface HistoryQuery {
  pipelineId?: string;
  query: string;
  offset: number;
}

// A launcher can acknowledge a mutation before its events reach the history reader.
export const MUTATION_VISIBILITY_DELAY_MS = 80;

export interface StudioDataState {
  accessDenied?: StudioAccessDenied;
  connected: boolean;
  historyQuery: HistoryQuery;
  selection: StudioRunSelection;
  manualRefreshing: boolean;
  snapshot: StudioSnapshot | null;
  /** The accepted snapshot retains its request identity until the next read lands. */
  snapshotQuery?: HistoryQuery;
}

export interface StudioDataInvalidation {
  delayMs?: number;
  resetHistory?: boolean;
}

type StudioDataListener = (state: StudioDataState) => void;
function clearedSnapshot(snapshot: StudioSnapshot): StudioSnapshot {
  return {
    ...snapshot,
    activeRunCount: 0,
    completedRunCount: 0,
    definitions: [],
    pipelines: [],
    failedRunCount: 0,
    runCount: 0,
    eventCount: 0,
    rootRunCount: 0,
    matchingRootCount: 0,
    offset: 0,
    selectedRun: undefined,
    lastEventId: 0,
    liveRunIds: [],
    runs: [],
  };
}

export class StudioDataController {
  readonly #api: StudioApi;
  readonly #unsubscribeAccess: (() => void) | undefined;
  readonly #detailRetryMs: number;
  readonly #listeners = new Set<StudioDataListener>();
  #detail: RunDetailLoader | undefined;
  #disposed = false;
  #invalidationTimeout: ReturnType<typeof setTimeout> | undefined;
  #snapshotEpoch = 0;
  #snapshotRefreshActive = false;
  #snapshotRefreshQueued = false;
  #state: StudioDataState;

  constructor(
    api: StudioApi,
    {
      runId = null,
      pipelineId,
      detailRetryMs = DEFAULT_DETAIL_RETRY_MS,
    }: { runId?: string | null; pipelineId?: string; detailRetryMs?: number } = {}
  ) {
    this.#api = api;
    this.#detailRetryMs = detailRetryMs;
    this.#state = {
      connected: true,
      historyQuery: { pipelineId, query: "", offset: 0 },
      selection: runId ? { status: "loading", runId } : { status: "none" },
      manualRefreshing: false,
      snapshot: null,
    };
    this.#unsubscribeAccess = api.subscribeAccessDenied?.((status) => {
      this.#snapshotEpoch += 1;
      this.#retireDetail();
      this.#clearSnapshotDelay();
      this.#snapshotRefreshQueued = false;
      this.#update({
        accessDenied: status,
        connected: false,
        snapshot: null,
        snapshotQuery: undefined,
        selection: { status: "none" },
        manualRefreshing: false,
      });
    });
  }

  getState(): StudioDataState {
    return this.#state;
  }

  subscribe(listener: StudioDataListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  setHistoryQuery({
    query = "",
    offset = 0,
  }: Partial<Pick<HistoryQuery, "query" | "offset">>): void {
    if (this.#disposed || this.#state.accessDenied) return;
    const current = this.#state.historyQuery;
    if (current.query === query && current.offset === offset) return;
    this.#snapshotEpoch += 1;
    this.#update({ historyQuery: { pipelineId: current.pipelineId, query, offset } });
    this.refresh(true);
  }

  setNavigation(route: Pick<StudioRoute, "pipelineId" | "runId">): void {
    if (!this.#applyNavigation(route)) return;
    this.#clearSnapshotDelay();
    const selection = this.#state.selection;
    if (selection.status === "loading" && selection.summary) this.#loadDetail(selection.summary);
    this.refresh(true);
  }

  openAcceptedRun(route: Pick<StudioRoute, "pipelineId" | "runId">): void {
    this.#applyNavigation(route);
    this.invalidate({ delayMs: MUTATION_VISIBILITY_DELAY_MS });
  }

  #applyNavigation({ pipelineId, runId }: Pick<StudioRoute, "pipelineId" | "runId">): boolean {
    if (this.#disposed || this.#state.accessDenied) return false;
    const { historyQuery, selection, snapshot, snapshotQuery } = this.#state;
    const sameScope = historyQuery.pipelineId === pipelineId;
    const sameRun = (runId ?? null) === this.#selectedRunId();
    if (sameScope && sameRun) return false;
    const summary = !sameRun && runId ? this.#findSummary(runId) : undefined;
    const visible =
      summary &&
      historyQuery === snapshotQuery &&
      snapshot?.runs.some(
        (listed) => listed.runId === summary.rootRunId || listed.runId === summary.runId
      );
    if (!sameRun) this.#retireDetail();
    this.#snapshotEpoch += 1;
    this.#update({
      historyQuery:
        sameScope && (sameRun || visible) ? historyQuery : { pipelineId, query: "", offset: 0 },
      selection: sameRun
        ? selection
        : runId
          ? { status: "loading", runId, summary }
          : { status: "none" },
    });
    return true;
  }

  refresh(manual = false): void {
    if (this.#disposed || this.#state.accessDenied || this.#invalidationTimeout !== undefined)
      return;
    if (manual) this.#update({ manualRefreshing: true });
    if (this.#snapshotRefreshActive) {
      if (manual) this.#snapshotRefreshQueued = true;
      return;
    }
    this.#startSnapshotRefresh();
  }

  invalidate({ delayMs = 0, resetHistory = false }: StudioDataInvalidation = {}): void {
    if (this.#disposed || this.#state.accessDenied) return;
    this.#snapshotEpoch += 1;
    const runId = this.#selectedRunId();
    if (resetHistory) {
      this.#retireDetail();
      const historyQuery = {
        pipelineId: this.#state.historyQuery.pipelineId,
        query: "",
        offset: 0,
      };
      const snapshot = this.#state.snapshot;
      this.#update({
        historyQuery,
        selection: runId ? { status: "unavailable", runId } : { status: "none" },
        snapshot: snapshot ? clearedSnapshot(snapshot) : null,
        snapshotQuery: snapshot ? historyQuery : undefined,
      });
    } else {
      this.#detail?.invalidate(delayMs);
    }
    this.#clearSnapshotDelay();
    if (delayMs > 0) {
      this.#snapshotRefreshQueued = false;
      this.#invalidationTimeout = setTimeout(() => {
        this.#invalidationTimeout = undefined;
        this.refresh(true);
      }, delayMs);
      return;
    }
    this.refresh(true);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#unsubscribeAccess?.();
    this.#disposed = true;
    this.#snapshotEpoch += 1;
    this.#retireDetail();
    this.#clearSnapshotDelay();
    this.#listeners.clear();
  }

  #selectedRunId(): string | null {
    return this.#state.selection.status === "none" ? null : this.#state.selection.runId;
  }

  #clearSnapshotDelay(): void {
    if (this.#invalidationTimeout !== undefined) clearTimeout(this.#invalidationTimeout);
    this.#invalidationTimeout = undefined;
  }

  #findSummary(runId: string): StoredRunSummary | undefined {
    const { snapshot, selection } = this.#state;
    return (
      (snapshot?.selectedRun?.runId === runId ? snapshot.selectedRun : undefined) ??
      snapshot?.runs.find((run) => run.runId === runId) ??
      (selection.status === "ready"
        ? (selection.detail.children.find((run) => run.runId === runId) ??
          selection.detail.ancestors.find((run) => run.runId === runId))
        : undefined)
    );
  }

  #acceptSnapshot(snapshot: StudioSnapshot, snapshotQuery: HistoryQuery): void {
    let selection = this.#state.selection;
    const runId = this.#selectedRunId();
    if (runId) {
      const summary = snapshot.selectedRun ?? snapshot.runs.find((run) => run.runId === runId);
      if (summary?.runId === runId) {
        selection =
          selection.status === "ready"
            ? { ...selection, summary }
            : { status: "loading", runId, summary };
        this.#update({ connected: true, snapshot, snapshotQuery, selection });
        this.#loadDetail(summary);
        return;
      }
      this.#retireDetail();
      selection = { status: "unavailable", runId };
    }
    this.#update({ connected: true, snapshot, snapshotQuery, selection });
  }

  #startSnapshotRefresh(): void {
    if (this.#disposed || this.#state.accessDenied) return;
    this.#snapshotRefreshActive = true;
    const epoch = this.#snapshotEpoch;
    const query = this.#state.historyQuery;
    void this.#api
      .loadSnapshot({ ...query, selectedRunId: this.#selectedRunId() })
      .then((snapshot) => {
        if (this.#disposed || this.#state.accessDenied || epoch !== this.#snapshotEpoch) return;
        this.#acceptSnapshot(snapshot, query);
      })
      .catch(() => {
        if (this.#disposed || this.#state.accessDenied || epoch !== this.#snapshotEpoch) return;
        this.#update({ connected: false });
      })
      .finally(() => {
        if (this.#disposed || this.#state.accessDenied) return;
        this.#snapshotRefreshActive = false;
        if (this.#invalidationTimeout !== undefined) return;
        if (this.#snapshotRefreshQueued) {
          this.#snapshotRefreshQueued = false;
          this.#startSnapshotRefresh();
          return;
        }
        if (this.#state.manualRefreshing) this.#update({ manualRefreshing: false });
      });
  }

  #loadDetail(summary: StoredRunSummary): void {
    this.#detail ??= new RunDetailLoader(
      this.#api,
      summary.runId,
      (detail) => {
        const selection = this.#state.selection;
        if (
          detail &&
          (selection.status === "loading" || selection.status === "ready") &&
          selection.summary
        ) {
          this.#update({
            selection: {
              status: "ready",
              runId: summary.runId,
              summary: selection.summary,
              detail,
            },
          });
        }
      },
      this.#detailRetryMs
    );
    this.#detail.update(summary);
  }

  #retireDetail(): void {
    this.#detail?.dispose();
    this.#detail = undefined;
  }

  #update(update: Partial<StudioDataState>): void {
    this.#state = { ...this.#state, ...update };
    for (const listener of this.#listeners) listener(this.#state);
  }
}
