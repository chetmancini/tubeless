import type { StoredRunSummary } from "../../run-store/run-history.js";
import type { StudioApi, StudioRunDetail } from "./transport.js";

export const DEFAULT_DETAIL_RETRY_MS = 1_200;
type Revision = Pick<StoredRunSummary, "eventCount" | "subtreeEventCount" | "rootRunId" | "status">;

function sameRevision(left: Revision | undefined, right: Revision | undefined): boolean {
  return (
    left?.eventCount === right?.eventCount &&
    left?.subtreeEventCount === right?.subtreeEventCount &&
    left?.rootRunId === right?.rootRunId &&
    left?.status === right?.status
  );
}

/** One run's detail reads: retain successes, coalesce revisions and retry missing/failed reads. */
export class RunDetailLoader {
  #wanted: Revision | undefined;
  #loaded: Revision | undefined;
  #detail: StudioRunDetail | null = null;
  #request: object | undefined;
  #retry: ReturnType<typeof setTimeout> | undefined;
  #disposed = false;

  constructor(
    private readonly api: Pick<StudioApi, "loadRunDetail">,
    private readonly runId: string,
    private readonly accept: (detail: StudioRunDetail | null) => void,
    private readonly retryMs = DEFAULT_DETAIL_RETRY_MS
  ) {}

  update(summary: StoredRunSummary): void {
    if (this.#disposed) return;
    const { eventCount, subtreeEventCount, rootRunId, status } = summary;
    this.#wanted = { eventCount, subtreeEventCount, rootRunId, status };
    this.#load();
  }

  /** Retire pending reads after an explicit mutation, retaining the last displayed detail. */
  invalidate(delayMs = 0): void {
    if (this.#disposed) return;
    this.#retire();
    this.#loaded = undefined;
    if (delayMs > 0) this.#schedule(delayMs);
    else this.#load();
  }

  dispose(): void {
    this.#disposed = true;
    this.#retire();
  }

  #load(): void {
    if (
      this.#disposed ||
      this.#request ||
      this.#retry !== undefined ||
      !this.#wanted ||
      sameRevision(this.#loaded, this.#wanted)
    )
      return;
    const revision = this.#wanted;
    const request = (this.#request = {});
    void this.api.loadRunDetail(this.runId).then(
      (detail) => {
        if (this.#request !== request) return;
        this.#request = undefined;
        if (detail?.run.runId !== this.runId) {
          if (detail === null && this.#detail === null) this.accept(null);
          this.#schedule(this.retryMs);
          return;
        }
        this.#detail = detail;
        this.#loaded = revision;
        this.accept(detail);
        // Publish this success even if newer events arrived, then read the newest revision once.
        this.#load();
      },
      () => {
        if (this.#request !== request) return;
        this.#request = undefined;
        this.#schedule(this.retryMs);
      }
    );
  }

  #schedule(delayMs: number): void {
    if (this.#disposed || this.#retry !== undefined) return;
    this.#retry = setTimeout(() => {
      this.#retry = undefined;
      this.#load();
    }, delayMs);
  }

  #retire(): void {
    this.#request = undefined;
    if (this.#retry !== undefined) clearTimeout(this.#retry);
    this.#retry = undefined;
  }
}
