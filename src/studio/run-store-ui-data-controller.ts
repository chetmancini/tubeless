import type {
  StudioApi,
  StudioRunDetail,
  StudioSnapshot,
} from "./run-store-ui-client-transport.js";

export interface StudioDataState {
  connected: boolean;
  detail: StudioRunDetail | null;
  manualRefreshing: boolean;
  snapshot: StudioSnapshot | null;
}

export interface StudioDataInvalidation {
  delayMs?: number;
  resetHistory?: boolean;
}

type StudioDataListener = (state: StudioDataState) => void;

const DEFAULT_DETAIL_RETRY_MS = 1_200;

function clearedSnapshot(snapshot: StudioSnapshot): StudioSnapshot {
  return {
    ...snapshot,
    activeRunCount: 0,
    completedRunCount: 0,
    definitions: [],
    failedRunCount: 0,
    lastEventId: 0,
    liveRunIds: [],
    runs: [],
  };
}

/** Owns Studio snapshot freshness and selection-scoped detail loading. */
export class StudioDataController {
  readonly #api: StudioApi;
  readonly #detailRetryMs: number;
  readonly #listeners = new Set<StudioDataListener>();
  #detailRequest: object | null = null;
  #detailRetryTimeout: ReturnType<typeof setTimeout> | undefined;
  #detailSelection = { fingerprint: null as string | null, runId: null as string | null };
  #detailSelectionVersion = 0;
  #disposed = false;
  #invalidationTimeout: ReturnType<typeof setTimeout> | undefined;
  #manualRefreshPending = false;
  #snapshotEpoch = 0;
  #snapshotRefreshActive = false;
  #snapshotRefreshQueued = false;
  #state: StudioDataState = {
    connected: true,
    detail: null,
    manualRefreshing: false,
    snapshot: null,
  };

  constructor(api: StudioApi, detailRetryMs = DEFAULT_DETAIL_RETRY_MS) {
    this.#api = api;
    this.#detailRetryMs = detailRetryMs;
  }

  getState(): StudioDataState {
    return this.#state;
  }

  subscribe(listener: StudioDataListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  refresh(manual = false): void {
    if (this.#disposed) return;
    if (manual) {
      this.#manualRefreshPending = true;
      this.#update({ manualRefreshing: true });
    }
    if (this.#snapshotRefreshActive) {
      if (manual) this.#snapshotRefreshQueued = true;
      return;
    }
    this.#startSnapshotRefresh();
  }

  invalidate({ delayMs = 0, resetHistory = false }: StudioDataInvalidation = {}): void {
    if (this.#disposed) return;
    this.#snapshotEpoch += 1;
    if (resetHistory) {
      this.#resetDetail();
      this.#update({
        detail: null,
        snapshot: this.#state.snapshot ? clearedSnapshot(this.#state.snapshot) : null,
      });
    } else {
      this.#invalidateDetail(delayMs);
    }
    if (this.#invalidationTimeout) clearTimeout(this.#invalidationTimeout);
    this.#invalidationTimeout = undefined;
    if (delayMs > 0) {
      this.#invalidationTimeout = setTimeout(() => {
        this.#invalidationTimeout = undefined;
        this.refresh(true);
      }, delayMs);
      return;
    }
    this.refresh(true);
  }

  selectRun(runId: string | null, fingerprint: string | null): void {
    if (this.#disposed) return;
    if (
      this.#detailSelection.runId === runId &&
      this.#detailSelection.fingerprint === fingerprint
    ) {
      return;
    }
    // A new revision of the selected run refreshes its data without retiring
    // the current read or blanking the last successful detail.
    if (this.#detailSelection.runId !== runId || !fingerprint) {
      this.#resetDetail();
      this.#update({ detail: null });
    }
    this.#detailSelection = { fingerprint, runId };
    if (runId && fingerprint) this.#loadDetail(this.#detailSelectionVersion);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#snapshotEpoch += 1;
    this.#detailSelectionVersion += 1;
    this.#detailRequest = null;
    if (this.#detailRetryTimeout) clearTimeout(this.#detailRetryTimeout);
    if (this.#invalidationTimeout) clearTimeout(this.#invalidationTimeout);
    this.#detailRetryTimeout = undefined;
    this.#invalidationTimeout = undefined;
    this.#listeners.clear();
  }

  #startSnapshotRefresh(): void {
    if (this.#disposed) return;
    this.#snapshotRefreshActive = true;
    const epoch = this.#snapshotEpoch;
    this.#manualRefreshPending = false;
    void this.#api
      .loadSnapshot()
      .then((snapshot) => {
        if (this.#disposed || epoch !== this.#snapshotEpoch) return;
        this.#update({ connected: true, snapshot });
      })
      .catch(() => {
        if (this.#disposed || epoch !== this.#snapshotEpoch) return;
        this.#update({ connected: false });
      })
      .finally(() => {
        if (this.#disposed) return;
        this.#snapshotRefreshActive = false;
        if (this.#snapshotRefreshQueued) {
          this.#snapshotRefreshQueued = false;
          this.#startSnapshotRefresh();
          return;
        }
        if (!this.#manualRefreshPending) this.#update({ manualRefreshing: false });
      });
  }

  #loadDetail(selectionVersion: number): void {
    const { fingerprint, runId } = this.#detailSelection;
    if (
      this.#disposed ||
      this.#detailRequest !== null ||
      this.#detailRetryTimeout !== undefined ||
      !runId ||
      !fingerprint ||
      selectionVersion !== this.#detailSelectionVersion
    ) {
      return;
    }
    const request = {};
    this.#detailRequest = request;
    void this.#api
      .loadRunDetail(runId)
      .then((detail) => {
        if (!this.#detailRequestIsCurrent(request, selectionVersion)) return;
        this.#detailRequest = null;
        if (detail) {
          this.#update({ detail });
          // Coalesce revisions received during this read into one follow-up.
          if (fingerprint !== this.#detailSelection.fingerprint) this.#loadDetail(selectionVersion);
          return;
        }
        this.#scheduleDetailRetry(selectionVersion);
      })
      .catch(() => {
        if (!this.#detailRequestIsCurrent(request, selectionVersion)) return;
        this.#detailRequest = null;
        this.#scheduleDetailRetry(selectionVersion);
      });
  }

  #detailRequestIsCurrent(request: object, selectionVersion: number): boolean {
    return (
      !this.#disposed &&
      this.#detailRequest === request &&
      this.#detailSelectionVersion === selectionVersion
    );
  }

  #scheduleDetailRetry(selectionVersion: number): void {
    if (this.#disposed || selectionVersion !== this.#detailSelectionVersion) return;
    if (this.#detailRetryTimeout) clearTimeout(this.#detailRetryTimeout);
    this.#detailRetryTimeout = setTimeout(() => {
      this.#detailRetryTimeout = undefined;
      this.#loadDetail(selectionVersion);
    }, this.#detailRetryMs);
  }

  #invalidateDetail(delayMs: number): void {
    this.#detailSelectionVersion += 1;
    this.#detailRequest = null;
    if (this.#detailRetryTimeout) clearTimeout(this.#detailRetryTimeout);
    this.#detailRetryTimeout = undefined;
    this.#update({ detail: null });
    const selectionVersion = this.#detailSelectionVersion;
    if (!this.#detailSelection.runId || !this.#detailSelection.fingerprint) return;
    if (delayMs > 0) {
      this.#detailRetryTimeout = setTimeout(() => {
        this.#detailRetryTimeout = undefined;
        this.#loadDetail(selectionVersion);
      }, delayMs);
      return;
    }
    this.#loadDetail(selectionVersion);
  }

  #resetDetail(): void {
    this.#detailSelectionVersion += 1;
    this.#detailRequest = null;
    this.#detailSelection = { fingerprint: null, runId: null };
    if (this.#detailRetryTimeout) clearTimeout(this.#detailRetryTimeout);
    this.#detailRetryTimeout = undefined;
  }

  #update(update: Partial<StudioDataState>): void {
    const state = { ...this.#state, ...update };
    if (
      state.connected === this.#state.connected &&
      state.detail === this.#state.detail &&
      state.manualRefreshing === this.#state.manualRefreshing &&
      state.snapshot === this.#state.snapshot
    ) {
      return;
    }
    this.#state = state;
    for (const listener of this.#listeners) listener(state);
  }
}
