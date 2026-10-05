import {
  createPipelineRunProjector,
  type PipelineRunEventReader,
  type PipelineRunStoreSnapshot,
  type StoredPipelineEvent,
  type StoredPipelineRun,
} from "../run-store/run-store.js";
import { readPipelineEventPages } from "../run-store/run-store-reader.js";
import {
  createRunHistoryIndex,
  summarizeDefinition,
  summarizeRun,
  type RunHistoryIndex,
  type StoredRunSummary,
  type StoredDefinitionSummary,
} from "../run-store/run-history.js";
import { projectPipelineRun } from "../run-store/run-store.js";
import {
  STUDIO_HISTORY_PAGE_SIZE,
  type StudioSnapshot,
  type StudioRunDetail,
  type StudioDefinitionDetail,
} from "./run-store-ui-schema.js";

export interface PipelineRunStudioHistoryMaintenance {
  clear(): void | Promise<void>;
  isBusy?(): boolean | Promise<boolean>;
}

export class PipelineRunStudioHistoryBusyError extends Error {
  constructor() {
    super("Wait for active runs to finish before clearing history.");
    this.name = "PipelineRunStudioHistoryBusyError";
  }
}

/** Serializes incremental store reads and history clearing for one studio server. */
export class PipelineRunStudioEventState {
  #lastEventId: number | undefined;
  #operation: Promise<void> = Promise.resolve();
  #projector = createPipelineRunProjector({ retainLogs: false, retainArtifacts: false });
  #revision = 0;
  #history:
    | {
        source: PipelineRunStoreSnapshot;
        index: RunHistoryIndex<StoredPipelineRun>;
        summaries: Map<string, StoredRunSummary>;
        roots: StoredRunSummary[];
        definitions: StoredDefinitionSummary[];
        eventCount: number;
        search?: { query: string; roots: StoredRunSummary[] };
      }
    | undefined;

  constructor(private readonly store: Pick<PipelineRunEventReader, "listEvents">) {}

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#operation.then(operation, operation);
    this.#operation = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  async #appendNewEvents(): Promise<void> {
    for await (const page of readPipelineEventPages(this.store, {
      afterId: this.#lastEventId,
      limit: 100_000,
    })) {
      this.#projector.append(page);
      this.#lastEventId = page.at(-1)!.id;
      this.#revision += 1;
    }
  }

  async #listRunEvents(runId: string): Promise<readonly StoredPipelineEvent[]> {
    const events: StoredPipelineEvent[] = [];
    for await (const page of readPipelineEventPages(this.store, { limit: 100_000, runId })) {
      events.push(...page);
    }
    return events;
  }

  #indexedHistory() {
    const source = this.#projector.snapshot();
    if (this.#history?.source === source) return this.#history;
    const index = createRunHistoryIndex(source.runs);
    const summaries = new Map(source.runs.map((run) => [run.runId, summarizeRun(run, index)]));
    const roots = index.roots
      .map((run) => summaries.get(run.runId)!)
      .sort(
        (left, right) =>
          Number(right.subtreeIsRunning) - Number(left.subtreeIsRunning) ||
          right.startedAtMs - left.startedAtMs
      );
    this.#history = {
      source,
      index,
      summaries,
      roots,
      definitions: source.definitions.map(summarizeDefinition),
      eventCount: source.runs.reduce((sum, run) => sum + run.eventCount, 0),
    };
    return this.#history;
  }

  workspace(query = "", offset = 0, selectedRunId?: string | null): Promise<StudioSnapshot> {
    return this.#serialize(async () => {
      await this.#appendNewEvents();
      const history = this.#indexedHistory();
      let roots = history.roots;
      if (query) {
        if (history.search?.query !== query) {
          const matches = history.index.matchingRootIds(query);
          history.search = { query, roots: roots.filter((run) => matches.has(run.runId)) };
        }
        roots = history.search.roots;
      }
      const { source } = history;
      const pageOffset = Math.min(
        offset,
        Math.max(0, Math.ceil(roots.length / STUDIO_HISTORY_PAGE_SIZE) - 1) *
          STUDIO_HISTORY_PAGE_SIZE
      );
      return {
        activeRunCount: source.activeRunCount,
        completedRunCount: source.completedRunCount,
        failedRunCount: source.failedRunCount,
        generatedAtMs: source.generatedAtMs,
        lastEventId: source.lastEventId,
        revision: this.#revision,
        runCount: source.runs.length,
        eventCount: history.eventCount,
        rootRunCount: history.roots.length,
        matchingRootCount: roots.length,
        offset: pageOffset,
        definitions: history.definitions,
        liveRunIds: [],
        runs: roots.slice(pageOffset, pageOffset + STUDIO_HISTORY_PAGE_SIZE),
        selectedRun: selectedRunId ? history.summaries.get(selectedRunId) : undefined,
        requestedRunId: selectedRunId || undefined,
      };
    });
  }

  detail(runId: string): Promise<StudioRunDetail | undefined> {
    return this.#serialize(async () => {
      await this.#appendNewEvents();
      const history = this.#indexedHistory();
      const events = await this.#listRunEvents(runId);
      if (events.length === 0) return undefined;
      const run = projectPipelineRun(events);
      return {
        run,
        ancestors: history.index.ancestorsOf(runId).map((run) => history.summaries.get(run.runId)!),
        children: history.index.childrenOf(runId).map((run) => history.summaries.get(run.runId)!),
        descendantCount: history.index.descendantCount(runId),
      };
    });
  }

  definition(
    pipelineId: string,
    definitionId?: string,
    offset = 0
  ): Promise<StudioDefinitionDetail | undefined> {
    return this.#serialize(async () => {
      await this.#appendNewEvents();
      const history = this.#indexedHistory();
      const definition = history.source.definitions.find(
        (entry) => entry.pipelineId === pipelineId && entry.identity?.definitionId === definitionId
      );
      if (!definition) return undefined;
      const runs = history.source.runs.filter(
        (run) =>
          run.pipelineId === pipelineId && run.definitionIdentity?.definitionId === definitionId
      );
      return {
        definition,
        runs: runs
          .slice(offset, offset + STUDIO_HISTORY_PAGE_SIZE)
          .map((run) => history.summaries.get(run.runId)!),
        offset,
        runCount: runs.length,
      };
    });
  }

  clear(
    history: PipelineRunStudioHistoryMaintenance
  ): Promise<{ eventCount: number; runCount: number }> {
    return this.#serialize(async () => {
      if (await history.isBusy?.()) throw new PipelineRunStudioHistoryBusyError();
      await this.#appendNewEvents();
      const snapshot = this.#projector.snapshot();
      await history.clear();
      this.#lastEventId = undefined;
      this.#projector.clear();
      this.#history = undefined;
      this.#revision += 1;
      return {
        eventCount: snapshot.runs.reduce((n, run) => n + run.eventCount, 0),
        runCount: snapshot.runs.length,
      };
    });
  }
}
