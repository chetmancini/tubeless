# Agent transcripts

Design for [issue 286](https://github.com/chetmancini/tubeless/issues/286).
Implemented: opt-in capture, a public Node NDJSON writer, validated artifact readers,
CLI history inspection and a paginated Studio conversation view. SQLite/Cloudflare
transcript persistence and public evaluation helpers remain subsequent stages.

## Contract and ownership

An agent may configure `transcript: { write, redact?, maxRecordBytes?, maxBytes? }`.
Without it, no content is copied or delivered. Each invocation owns its sequence,
byte budget and delivery queue. Child agents require their own explicit opt-in;
ordinary pipelines and code-mode calls inside an agent retain its capture scope.
The sink may be shared, but must partition records by `runId`.

Records use a separate versioned envelope with agent ID, agent run ID, optional
parent run ID, sequence, timestamp, turn and dry-run flag. Reserve turn zero for
invocation-level end events and use one-based turns for decisions and tools. They do not extend trace
events, definition identities, run reports or recovery checkpoints. Their run ID
joins existing structural history even when trace exporting is disabled.

Provider-neutral events contain:

- `prompt`: task and assembled instructions for a model decision, without native history.
- `assistant`: text blocks explicitly returned by the model, in response order.
- `decision`: the proposed decision, before harness validation, including raw call arguments
  or finish data. Recording a proposal does not imply its acceptance.
- `call`: validated tool input, including script-issued calls in code mode.
- `outcome`: a successful validated tool value or an expected tool error. Reused
  checkpoint outcomes are marked `replayed`.
- `compaction`: a successful provider compaction marker, without opaque summary state.
- `end`: completion, failure or cancellation of the agent invocation. Completed
  checkpoint replay emits only this event, marked `replayed`, without inventing past turns.

Custom decision loops produce decisions, calls, outcomes and an end event. Model
agents additionally produce prompts. The bundled providers produce assistant text
and compaction markers. They never export encrypted reasoning, thinking blocks,
signatures, native conversation state, credentials or raw HTTP bodies. A transcript
can explain observed actions; it is neither hidden reasoning nor a replayable provider
conversation. Custom transports can continue returning their existing response shape.

## Privacy, bounds and failure

Capture contains application data, including instructions, project guidance, file
contents, scripts and tool errors. Opt-in is independent of `--store` and `--trace`.
No built-in destination is selected. Applications own destination permissions,
retention, deletion, access controls and any durable storage. Their redactor receives
an owned, frozen event and returns a replacement of the same kind, or `null` to
suppress it. It cannot mutate runtime values or envelope identity. Validate the
replacement's kind and required fields before delivery; invalid replacements disable capture.

Before redaction, content is copied through a bounded plain-JSON projection. Cycles,
accessors, nonfinite numbers, undefined values, class instances and excessive depth
produce an `unsupported-content` omission. Oversized content produces a
`record-limit` omission; neither is silently shortened or passed to the redactor.
Redaction therefore sees only events that fit the initial content bound. Replacement
events are checked again. Omission markers contain no original content.

Each complete serialized record plus its newline is bounded to 64 KiB by default
and at most 64 KiB. Each invocation defaults to 1 MiB, with an allowed maximum of
16 MiB. The record limit is configurable down to 1 KiB; the total must allow at
least two records. The implementation reserves one record's budget for a final
`maxBytes` marker, then stops capture. That marker replaces further content and the
end event; absence of an end event does not establish a failed agent run. A metadata
envelope that cannot fit disables delivery. These bounds apply before storage, so
Cloudflare can store records separately without adding content to bounded trace rows.

Delivery is awaited and serialized per invocation, including concurrent tool results.
Providers and tools enqueue observations without awaiting sinks inside provider or code-mode deadlines;
the harness drains those observations with the next decision or terminal record,
including when a provider rejects its response.
Records follow observation/completion order; call IDs join results to their decisions.
There is no cross-run total order. A sink or redactor failure disables that invocation's
capture and emits one fixed warning without exception text or content. Agent results,
budgets, recovery and cancellation retain their normal semantics. Successful records
already delivered remain available after subsequent failures. Sinks must impose their
own I/O deadlines; slow delivery delays the run. Capture is best-effort inspection,
never an acknowledged recovery log. Process death may leave a partial transcript.

Dry-run skips create no transcript. Explicit preview callbacks create records marked
`dryRun`. Planning performs no capture. Replay does not re-export historical content;
records from different attempts remain distinct by runtime run ID.

## Reading: implemented artifact slice

Keep transcript readers separate from run-event readers. The current implementation
accepts an explicit finished NDJSON artifact through `--transcript <path>` on history
and Studio. It validates version, size and fields, deduplicates identical records,
rejects conflicts and pages by sequence. New Node writers serialize appends and use
private file permissions on creation. Reader snapshots never change after opening.
Studio serves content only for IDs present in structural history, behind the same
authentication and Host checks, and disables clearing while the artifact is attached.

For subsequent SQLite/Cloudflare storage, add optional capabilities beside the run event store.
Use `(runId, sequence)` for pagination and idempotent ingestion; validate the record
version and byte bounds at ingestion. SQLite may store separate rows; NDJSON uses
a separate file; Cloudflare uses separate bounded rows or object storage. An artifact
receipt can reference an externally stored transcript after successful persistence,
without embedding content in traces. Clearing history must explicitly include its
associated transcripts. Old history has no transcript and remains readable.

History renders the selected run's transcript in text or JSON. Studio offers a
conversation view with prompts, assistant text, calls, outcomes and omission markers,
linked to structural child runs. Pagination is bounded. Future mutable stores can
add live refresh through sequence cursors.
Show unavailable, partial, complete and limited recording states. Suppressed events
have no tombstones; no records cannot establish whether capture was disabled or fully
redacted, and must never imply an empty model conversation. Render content as text, never executable HTML. Transcript authorization
must match history authorization; storage paths and credentials stay server-side.

## Evaluation: subsequent stage

Extract fixture workspace setup/cleanup, immutable-file checks, transcript collection
and assertion reporting from `scripts/eval-agent.mjs` into `tubeless/testing` helpers.
Keep paid provider selection, credentials and product-specific scoring in the script.
Use scripted models in CI and run opt-in live cases through both bundled providers.
Reports consume transcript decisions/outcomes and compaction markers, eliminating
model wrappers and log-message matching. Assertions must detect omitted content
instead of treating an incomplete transcript as complete evidence.

The website replay should consume that same normalized evaluation output. Preserve
its existing report format through an explicit projection during migration. Token
streaming remains separate work: it needs bounded partial-text events, sink
backpressure and final-message reconciliation before it can extend this format.

## First-stage validation

Cover default-off behavior, raw proposals and validated tool values, expected and
fatal failures, cancellation/draining, concurrent invocations and calls, nested
agent opt-in, code mode, previews, recovery, redactor isolation/failure, unsupported
values, UTF-8 record/total bounds, provider text allowlists and successful compaction.
Compile a public-import example, regenerate API artifacts, rebuild the docs website
and run `make check`. No live paid model request is needed for this stage.

Artifact read-back also covers malformed/versioned records, private file creation,
append boundaries and serialization, immutable snapshots, gaps and conflicts,
run-scoped pagination, CLI output, Studio authorization, escaped rendering, and
request retries/retirement. Exercise pagination and structural turn links in a browser.
