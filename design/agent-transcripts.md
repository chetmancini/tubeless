# Agent transcripts

Design for [issue 286](https://github.com/chetmancini/tubeless/issues/286).
Implemented: opt-in capture, a public Node NDJSON writer, validated artifact readers,
CLI history inspection, a paginated Studio conversation view and public evaluation
helpers, explicit SQLite artifact import and direct SQLite capture for the built-in
workspace CLI. Follow-ups are tracked separately: live Studio refresh (#321),
Cloudflare persistence (#322), and terminal token streaming (#323).

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

## Reading: artifacts and SQLite import

Keep transcript readers separate from run-event readers. The current implementation
accepts an explicit finished NDJSON artifact through `--transcript <path>` on history
and Studio. It validates version, size and fields, deduplicates identical records,
rejects conflicts and pages by sequence. New Node writers serialize appends and use
private file permissions on creation. Reader snapshots never change after opening.
Studio serves content only for IDs present in structural history, behind the same
authentication and Host checks, and disables clearing while the artifact is attached.

SQLite history offers an optional transcript reader and atomic import capability
beside its event interface. `history --import-transcript <path>` validates a finished
artifact and stores separate version-1 rows keyed by `(runId, sequence)`. Matching
structural history is required. Identical records are idempotent; conflicts and
identity changes roll back the entire import. The optional table is created only
by explicit import or capture, and does not change the structural event schema or the
Cloudflare adapter. Reads use bounded sequence pages from a consistent transaction
snapshot. History clearing deletes content and events in the same transaction.
Old history without content remains readable. Imports inherit the database's
permissions and leave source artifacts unchanged.

The built-in CLI opts in with `agent --store <path> --capture-transcript` (#320).
The workbench opens the store before constructing its agent, supplies a sink using
existing ingestion, and keeps it alive until all prompts and cancellation drains
settle. Every accepted content record first flushes buffered structural events so
its run is already owned by history. Default per-record and per-run capture bounds
apply. The flag captures application content without a custom redactor, and selected
project/file agents retain ownership of their existing sinks. `--store` alone never
enables capture. Capture failures preserve ordinary best-effort semantics.

For subsequent Cloudflare storage, preserve these record and ownership boundaries. Cloudflare can use separate bounded rows or object storage.
An artifact receipt can reference externally stored content after successful
persistence without embedding it in traces.

History renders the selected run's transcript in text or JSON. Studio offers a
conversation view with prompts, assistant text, calls, outcomes and omission markers,
linked to structural child runs. Pagination is bounded. Imported SQLite content uses the same reader; reopen a conversation view after
further imports. Automatic live refresh remains subsequent work.
Show unavailable, partial, complete and limited recording states. Suppressed events
have no tombstones; no records cannot establish whether capture was disabled or fully
redacted, and must never imply an empty model conversation. Render content as text, never executable HTML. Transcript authorization
must match history authorization; storage paths and credentials stay server-side.

## Evaluation: implemented

`tubeless/testing` exposes a bounded `createAgentTranscriptCollector` with
`assertComplete(runId?)`, and a Node/Bun `createAgentTestWorkspace` with preserved-tree
assertions and owned cleanup. Complete evidence requires contiguous records,
consistent identity and a terminal end, with no omission/limit markers or collector
failure. Execution success remains a separate assertion. Suppression has no
tombstones and cannot be inferred from records alone.

The evaluator uses these helpers and supports OpenAI and Anthropic, while retaining
provider credentials, selection and fixture-specific scoring in the script. It
collects decisions/outcomes and compaction markers from transcripts. Descriptor
measurements use the provider's existing definition-time check hook. Offline CI
exercises both wire protocols, code mode, compaction and incomplete evidence.

The website replay retains its report format through an explicit transcript
projection; reports also retain raw records and validated nested tool calls. Token
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

SQLite import validation additionally covers idempotent writes, identity and key
conflicts, orphaned content, transaction rollback, bounded pagination and statuses,
read-only artifact preservation, multiple connections, and atomic event/content
deletion. The CLI/Studio integration imports real capture output, removes the
original artifact, inspects the saved content and clears the owning history.

Direct CLI capture validation covers default-off recording, separate prompt
sequences, real tool values, failed and cancelled prompts followed by further work,
private sink failures, early flag validation, and a credential-free public model
executed with Bun as well as the Node CLI tests.
