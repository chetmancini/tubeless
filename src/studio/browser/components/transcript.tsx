import type {
  AgentTranscriptPage,
  AgentTranscriptRecord,
} from "../../../tracing/agent-transcript.js";
import type { StudioApi } from "../transport.js";
import { useTranscript } from "../transcript-resource.js";

function RecordContent({ record }: { record: AgentTranscriptRecord }) {
  if ("omitted" in record)
    return (
      <p>
        {record.omitted} omitted: {record.reason}.
      </p>
    );
  if ("limit" in record)
    return <p>Capture stopped at its byte limit. Later content was not saved.</p>;
  const event = record.event;
  switch (event.kind) {
    case "assistant":
      return (
        <>
          <strong>Assistant</strong>
          <pre>{event.text}</pre>
        </>
      );
    case "prompt":
      return (
        <details>
          <summary>Prompt</summary>
          <h4>Task</h4>
          <pre>{event.task}</pre>
          <h4>Instructions</h4>
          <pre>{event.instructions}</pre>
        </details>
      );
    case "compaction":
      return <p>Conversation compacted by {event.provider}.</p>;
    case "end":
      return (
        <p>
          Agent {event.status}
          {event.replayed ? " · checkpoint replay" : ""}.
        </p>
      );
    case "call":
      return (
        <details>
          <summary>
            Call {event.tool} · {event.id}
          </summary>
          <pre>{JSON.stringify(event.input, null, 2)}</pre>
        </details>
      );
    case "outcome":
      return (
        <details>
          <summary>
            {event.outcome.tool} result · {event.outcome.id}
            {event.replayed ? " · reused" : ""}
          </summary>
          <pre>
            {JSON.stringify(event.outcome.ok ? event.outcome.value : event.outcome.error, null, 2)}
          </pre>
        </details>
      );
    case "decision":
      return (
        <details>
          <summary>Proposed decision</summary>
          <pre>{JSON.stringify(event.decision, null, 2)}</pre>
        </details>
      );
  }
}

export function TranscriptRecords({
  page,
  turnRuns,
  onOpenRun,
}: {
  page: AgentTranscriptPage;
  turnRuns: Readonly<Record<string, string>>;
  onOpenRun(id: string): void;
}) {
  return (
    <div class="transcript-records">
      <p class="sheet-subtitle">
        Saved transcript · {page.status}. Suppressed events are absent from this recording.
      </p>
      {page.status === "partial" && (
        <p role="status">
          This recording has gaps or no terminal marker. Use run history for the agent’s execution
          status.
        </p>
      )}
      {page.status === "unavailable" && (
        <p>
          No transcript records are available. Capture may have been disabled or all events
          suppressed.
        </p>
      )}
      {page.records.map((record, index) => {
        const turnRunId = turnRuns[record.turn];
        return (
          <section key={record.sequence} class="transcript-record">
            {(index === 0 || record.turn !== page.records[index - 1]?.turn) && (
              <div class="section-title">
                <span>
                  {record.turn ? `Turn ${record.turn}` : "Invocation"}
                  {record.dryRun ? " · preview" : ""}
                </span>
                {turnRunId && record.turn > 0 && (
                  <button
                    type="button"
                    class="secondary-button"
                    onClick={() => onOpenRun(turnRunId)}
                  >
                    Open turn
                  </button>
                )}
              </div>
            )}
            <RecordContent record={record} />
          </section>
        );
      })}
    </div>
  );
}

export function TranscriptView({
  load,
  runId,
  onOpenRun,
}: {
  load: NonNullable<StudioApi["loadTranscript"]>;
  runId: string;
  onOpenRun(id: string): void;
}) {
  const resource = useTranscript(load, runId);
  return (
    <div aria-busy={resource.loading}>
      {resource.page && (
        <TranscriptRecords
          page={resource.page}
          turnRuns={resource.turnRuns}
          onOpenRun={onOpenRun}
        />
      )}
      {resource.loading && <p role="status">Loading transcript…</p>}
      {resource.error && <p role="alert">{resource.error}</p>}
      {(resource.error || resource.page?.nextSequence !== undefined) && (
        <button
          type="button"
          class="secondary-button"
          disabled={resource.loading}
          onClick={resource.more}
        >
          {resource.error ? "Retry" : "Show more"}
        </button>
      )}
    </div>
  );
}
