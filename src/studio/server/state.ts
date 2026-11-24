import {
  createPipelineRunProjector,
  type PipelineRunEventReader,
  type StoredPipelineDefinition,
} from "../../run-store/run-store.js";
import {
  agentTranscriptPageSchema,
  type AgentTranscriptReader,
} from "../../tracing/agent-transcript.js";
import { readPipelineEventPages } from "../../run-store/run-store-reader.js";
import {
  matchesStudioTranscriptQuery,
  type StudioSnapshot,
  type StudioRunDetail,
  type StudioChildRuns,
  type StudioDefinitionRuns,
  type StudioTranscriptPage,
} from "../shared/schema.js";
import { StudioHistory } from "./history.js";
import { StudioRunDetails } from "./run-details.js";

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

export class PipelineRunStudioEventState {
  #lastEventId: number | undefined;
  #oldestEventId: number | undefined;
  #operation: Promise<void> = Promise.resolve();
  readonly #projector = createPipelineRunProjector({ retainLogs: false, retainArtifacts: false });
  readonly #details: StudioRunDetails;
  #revision = 0;
  #history: StudioHistory | undefined;

  constructor(private readonly store: Pick<PipelineRunEventReader, "listEvents">) {
    this.#details = new StudioRunDetails(store);
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#operation.then(operation, operation);
    this.#operation = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  #reset(): void {
    this.#lastEventId = undefined;
    this.#oldestEventId = undefined;
    this.#projector.clear();
    this.#details.clear();
    this.#history = undefined;
    this.#revision += 1;
  }

  async #checkForClear(): Promise<void> {
    if (this.#oldestEventId === undefined) return;
    const [oldest] = await this.store.listEvents({ limit: 1 });
    // Stores delete only by clearing everything; a different oldest event means another process cleared history.
    if (oldest?.id !== this.#oldestEventId) this.#reset();
  }

  async #readEventTail(): Promise<void> {
    for await (const page of readPipelineEventPages(this.store, {
      afterId: this.#lastEventId,
      limit: 100_000,
    })) {
      this.#oldestEventId ??= page[0].id;
      this.#projector.append(page);
      this.#lastEventId = page.at(-1)!.id;
      this.#revision += 1;
    }
  }

  async #appendNewEvents(): Promise<void> {
    await this.#checkForClear();
    await this.#readEventTail();
  }

  #indexedHistory(): StudioHistory {
    const source = this.#projector.snapshot();
    if (!this.#history?.update(source)) this.#history = new StudioHistory(source);
    return this.#history;
  }

  #readHistory<T>(read: (history: StudioHistory) => T | Promise<T>): Promise<T> {
    return this.#serialize(async () => {
      await this.#appendNewEvents();
      return read(this.#indexedHistory());
    });
  }

  workspace(
    query = "",
    offset = 0,
    selectedRunId?: string | null,
    pipelineId = ""
  ): Promise<StudioSnapshot> {
    return this.#readHistory((history) =>
      history.workspace(this.#revision, query, offset, selectedRunId, pipelineId)
    );
  }

  detail(runId: string): Promise<StudioRunDetail | undefined> {
    return this.#readHistory(async (history) => {
      const run = await this.#details.read(runId);
      return run ? history.detail(run) : undefined;
    });
  }

  childRuns(runId: string, page: number): Promise<StudioChildRuns | undefined> {
    return this.#readHistory((history) => history.childRuns(runId, page));
  }

  transcript(
    runId: string,
    afterSequence: number,
    reader: Pick<AgentTranscriptReader, "list">
  ): Promise<Pick<StudioTranscriptPage, "transcript" | "turnRuns"> | undefined> {
    return this.#serialize(async () => {
      // A known run remains in the append-only store until history is cleared.
      await this.#checkForClear();
      if (!this.#history?.hasRun(runId)) {
        await this.#readEventTail();
        if (!this.#indexedHistory().hasRun(runId)) return undefined;
      }
      const transcript = agentTranscriptPageSchema.decode(
        await reader.list({ runId, afterSequence }),
        "Transcript page"
      );
      if (!matchesStudioTranscriptQuery(transcript, runId, afterSequence))
        throw new Error("Transcript reader returned a mismatched run or cursor");
      // An external writer can commit a new turn before its transcript record is read.
      await this.#readEventTail();
      return {
        transcript,
        turnRuns: this.#indexedHistory().agentTurnRuns(
          runId,
          transcript.records.map((record) => record.turn)
        ),
      };
    });
  }

  definition(
    pipelineId: string,
    definitionId?: string
  ): Promise<StoredPipelineDefinition | undefined> {
    return this.#readHistory((history) => history.definition(pipelineId, definitionId));
  }

  definitionRuns(
    pipelineId: string,
    definitionId?: string,
    offset = 0
  ): Promise<StudioDefinitionRuns | undefined> {
    return this.#readHistory((history) => history.definitionRuns(pipelineId, definitionId, offset));
  }

  clear(
    history: PipelineRunStudioHistoryMaintenance
  ): Promise<{ eventCount: number; runCount: number }> {
    return this.#serialize(async () => {
      if (await history.isBusy?.()) throw new PipelineRunStudioHistoryBusyError();
      await this.#appendNewEvents();
      const snapshot = this.#projector.snapshot();
      await history.clear();
      this.#reset();
      return {
        eventCount: snapshot.runs.reduce((n, run) => n + run.eventCount, 0),
        runCount: snapshot.runs.length,
      };
    });
  }
}
