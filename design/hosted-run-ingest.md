# Hosted execution and remote event ingestion

Issue: [#289](https://github.com/chetmancini/tubeless/issues/289).

This change separates trusted hosted execution, launch coordination and storage
while preserving the public Cloudflare API. The HTTP section below is a proposed
next contract, not a shipped endpoint. Owned-attempt persistence and exact-byte
replay records are implemented internally. A Node-process test executor exercises the
shared coordination contract alongside Cloudflare; it is not a deployed remote
target or a second production execution lifecycle. No new public package subpath
is introduced.

## Ownership decision

Keep the reusable runner and launch bookkeeping internal to `hosting/`. A target
supplies the execution output/cwd, deadline policy, optional application-exporter
wrapper, event transport, and transactional store. Keep these outside core and
the public project API.

| Shared hosting responsibility                               | Cloudflare responsibility                                       |
| ----------------------------------------------------------- | --------------------------------------------------------------- |
| `RunJob`, `StudioIngest`, launch trace context              | Public Cloudflare binding-aware trace context                   |
| Ordered batching, delivery retries, bounded history text    | Durable Object RPC stubs                                        |
| Parse, admit, execute, flush, report delivery/setup failure | Alarm admission, watchdog, KV cleanup, live cancellation        |
| Per-job cooperative deadline                                | Fourteen-minute maximum and five-second app-exporter operations |
| Async launch coordination and atomic store operations       | Durable Object SQL adapter, schema setup and recovery alarms    |
| Launch/run linkage and existing host-failure completion     | Access authentication, Worker routing, R2 and Worker Loader     |

The runner uses the job's execution budget. Cloudflare clamps that budget before
calling it and supplies its existing application-exporter wrapper. The wrapper
receives the actual run deadline, so operation timeouts remain inside that budget.
The Cloudflare alarm state machine and watchdog stay together. No compatibility
re-export is needed for these private modules.

`HostedRunCoordinator` consumes two internal capabilities: `HostedExecutor`
(start and request cancellation by launch ID) and `HostedLaunchStore` (async
atomic launch/history operations). Neither exposes SQL, Durable Objects or alarms.
Targets arrange recovery before dispatch through `scheduleReconcile`; a scheduling
failure prevents dispatch. The coordinator observes preparation and dispatch in
a background task, independently of its start-acknowledgement timeout. A stalled
store, scheduler or failure recording cannot hold the response open indefinitely.
Timing out does not cancel dispatch: the run may still start after recovery is
arranged, as the response warns. Cancellation acknowledges a request, not
termination. Studio awaits live-run reads so remote databases do not need a
synchronous cache.

Keep transaction semantics inside each store adapter. Batch acceptance commits
history and its launch sequence/state together. `failUnadmitted` atomically checks
admission and fails a launch; splitting that into a read followed by a write would
race on an async backend. `fail` records a host-reported failure and closes its
open subtree; the caller must supply evidence appropriate to its platform.

`SqliteHostedLaunchStore` implements the port directly, with synchronous
transaction bodies and event appends on the same connection. Return the persisted
root run ID on accepted batch replays, including after completion or a collector
restart. A committed batch whose store reply was lost can then acknowledge its
start on retry. Reject new terminal-launch batches without advancing the committed
sequence, so rejected retries stay rejected. Table names, indexes and event
representations remain unchanged; no migration is required. Schema initialization,
storage versions, connections and drivers remain adapter-owned. A different
database implements the operation contract rather than emulating SQLite SQL or
synchronous transactions.

The test-only `createProcessHostedExecutor` in
`src/hosting/process-executor.test-support.ts` runs the shared runner in a Node
process with explicit output/cwd, active controllers and drain/close operations.
Integration tests drive it through Studio using native SQLite, cancellation,
duplicate dispatch and a closed/reopened collector database. Fault injection
covers lost store replies and stalled preparation, dispatch and failure writes.
This validates the contract with a second execution path, not a second production
executor or database implementation. The CLI retains its existing local launcher.
The test executor's deduplication lasts for one instance; it provides no isolation,
durable scheduling, distributed attempt fencing or recovery after process death.

## Current guarantees and limits

The runner parses values and obtains admission before executing a command. A
refused or unconfirmed admission never starts pipeline execution. It sends one ordered
sequence of event batches and retries failed delivery through a fresh ingest
capability. Refusal or exhausted retries aborts execution; active work still
depends on cooperative cancellation. Final flushing drains delivery timers.

The trusted `HostedLaunchStore.acceptBatch` path accepts any sequence at or below
the committed high-water mark as a duplicate, without comparing event content.
It relies on the current single-run-object caller. Owned attempts use the separate
operations below; their launches cannot use the trusted admission or append path
to bypass owner checks. Neither path is an authenticated network service. Do not
mount `StudioIngest` as HTTP merely by decoding requests into its interface.

Admission is consent, not a distributed execution lease. The Durable Object run
state and alarm serialization prevent a second execution. Repeated `admit` calls
alone do not provide that property for containers or queue deliveries.

Cloudflare documents at-least-once alarms and automatic retries of throwing
handlers. Keep the current non-rethrowing alarm path and persisted running marker.
Its SQL transactions keep launch changes and appended events atomic.
[Alarm API](https://developers.cloudflare.com/durable-objects/api/alarms/),
[SQLite storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/).

## Implemented attempt persistence

`HostedAttemptStore` is an internal operation-level contract implemented by
`SqliteHostedLaunchStore`. It does not dispatch jobs or issue credentials. The
host provisions a new launch and its only attempt atomically with an expected
pipeline ID and host-selected deployment revision. Provisioning conflicting IDs
rejects without overwriting records or leaving an orphan launch. Existing launch
and event tables keep their layout; the adapter adds three tables on open:

- `tubeless_attempts`: the unique launch/attempt association, expected pipeline and
  deployment IDs, winning worker invocation, claim time and revocation marker.
- `tubeless_attempt_runs`: globally unique root/descendant run bindings with stable
  pipeline and parent identities.
- `tubeless_attempt_batches`: exact-body SHA-256 digests and original root-run
  acknowledgements keyed by attempt and committed sequence. Store no extra copy
  of raw request bodies here.

`claimAttempt` grants execution exactly once to the first matching worker and
marks launch admission in the same transaction. Workers must generate a fresh
invocation ID, independently of a redelivered job. Repeating even the winning
worker's claim returns false. A lost claim reply leaves permission unconfirmed;
the worker must not run, and neither a restart nor elapsed time grants a new
owner. Preserve launch/attempt IDs on uncertain provisioning instead of creating
a fresh execution. There is no takeover or automatic execution retry in this
slice. The deployment ID check binds declared configuration; it is not binary
attestation and still requires a trusted launcher and authenticated worker setup.

`acceptAttemptBatch` accepts an owner identity and exact UTF-8 bytes for
`{ attemptId, sequence, events }`. It copies both before asynchronous hashing,
uses the canonical stored-event decoder, and requires trace version 3. The
internal envelope allows 1–50 events, at most 1 MiB of encoded bytes, and bounded
nonempty IDs; retain workload probes before publishing transport limits. The
HTTP layer must enforce limits while reading and authenticate before parsing.

Inside one synchronous SQLite transaction, the adapter checks the persisted
owner, revocation and body scope; compares any existing receipt; validates root
and descendant ownership; appends events; advances launch state/sequence; and
inserts the receipt. A root must match the provisioned pipeline. Reject another
root, a reused run ID (including one in trusted history), children before their
parents, foreign parents, and inconsistent event pipeline/parent identities.
A failure at any point rolls back bindings, history, launch state and receipt.

An identical committed retry returns its original acknowledgement, including
after completion or collector reopen. Altering even whitespace at an accepted
sequence conflicts. A gap reports the expected next sequence; a closed launch
refuses new writes without consuming their sequence. Revocation blocks both new
writes and receipt replays, including a batch whose hashing began before the
revocation committed. It does not terminate a worker or synthesize terminal
history. Existing host-admin failure operations still require evidence of actual
host failure; lost contact alone is not that evidence.

The persistence tests cover parallel claims from independent Node worker
connections, close/reopen and competing writers, altered retries, ownership
violations, schema rejection and rollback after event and receipt failures. The
Durable Object SQL fixture exercises the same operations without new platform
imports. Existing Cloudflare launches continue using trusted RPC; production
worker dispatch, credential authority and failure-report transport remain work
for the following slices.

## Proposed HTTP contract

Use an external container or CI job as the first independent executor when one is
chosen. Keep the ingest service separate from Studio's browser/admin routes and
credentials. It only appends to an already-created launch; it cannot submit jobs,
select executable modules, cancel other runs, clear history, or read Studio data.
The application continues to own launch creation and executor supervision.

### Authority and provisioning

Create a random, launch-scoped credential with at least 256 bits of entropy when
the trusted application provisions an execution attempt. Persist its verifier,
launch ID, attempt ID, expected command/implementation identity, validity window
and revocation state together. Store only a verifier, and pass the secret to the
worker through the host's secret channel. Do not put it in trace events, job input
values, URLs, logs, or browser configuration.

Authenticate every request with `Authorization: Bearer <credential>` over HTTPS.
Bind the credential to exactly one launch and attempt. Do not accept Studio
gateway tokens or browser sessions as executor authority. Authenticate before
reading a body or looking up user-visible launch state. Use generic unauthorized
responses for missing, invalid, expired or mismatched authority. Reject redirects
on the client, omit CORS grants, and return `Cache-Control: no-store`.

Keep expiry and revocation explicit. A terminal launch may retain a narrow replay
window for acknowledging already-committed batches; it must not accept new work.
History retention must not delete active attempt/credential state. Never reuse a
launch ID or credential after history cleanup.

### Operations

The following paths are proposed for a separately mounted internal service, not
reserved routes in the current Studio server:

| POST path                         | Request                             | Successful response                 |
| --------------------------------- | ----------------------------------- | ----------------------------------- |
| `/v1/launches/{launchId}/admit`   | `{ attemptId }`                     | `{ admitted }`                      |
| `/v1/launches/{launchId}/batches` | `{ attemptId, sequence, events }`   | `{ accepted, duplicate, sequence }` |
| `/v1/launches/{launchId}/failure` | `{ attemptId, failureId, message }` | `{ recorded }`                      |

Version the transport independently from native trace events. For v1 writes,
validate the current version 3 event schema; accepting older recordings for reads
does not make them valid remote writes. Validate IDs, safe nonnegative integer
sequences, request shape and every event before entering a write transaction.
Bound UTF-8 bodies while streaming, even without `Content-Length`; initially cap
batches at 50 events and 1 MiB encoded bytes and failure messages at 8 KiB. Reject
oversized individual events rather than silently changing identity-bearing data.
The sender must split by both count and bytes and retain the exact encoded body
through retries. These wire limits need probes against real definition snapshots
before becoming an implemented contract.

Use 400 for invalid input, 401 for invalid authority, 409 for an admission/sequence
conflict, 410 for a closed/revoked attempt, 413 for size limits, and 503 for a
transient unavailable collector. Do not return stored event payloads in errors.
Never treat a collector failure as permission to run without admission.

### Batch identity and event ownership

Persist a digest of each exact accepted request body with its launch, attempt and
sequence. Retain those digests for the credential's replay lifetime. In the same
transaction, validate event ownership, append events, bind new descendant runs and
advance the sequence. A retry with the same sequence and digest receives its
original acknowledgement without adding rows. A changed body at an accepted
sequence is a conflict; a gap reports the expected next sequence. A terminal
attempt can acknowledge an identical committed retry but refuses every new batch.
The current high-water mark alone cannot implement these rules.

Bind the first root `pipeline.started` to the launch's expected pipeline and run.
Reject a second root, a run ID owned by another launch, and child starts whose
parent is neither already bound nor introduced earlier in the same batch. Accept
events only for the bound root and its validated descendants. Persist those
bindings and reject the whole batch on failure. Validate the expected deployed
identity before execution; a structural definition hash is not proof of code
equality. Inputs and credentials are not tracing metadata.

### Admission, lost contact and cancellation

Use the persisted attempt/ownership operations for remote admission. Bind each
request to its authenticated attempt and fresh worker invocation; duplicate queue
deliveries must not obtain another execution grant. Retrying a batch must never
retry pipeline execution. A timed-out claim request has an uncertain outcome;
do not execute or provision a fresh attempt based on that timeout.

An expired heartbeat or failed HTTP request does not prove that a container
stopped. Record lost contact as an uncertain host outcome, retain possible side
effects, and require supervision or explicit recovery before another attempt can
execute. Do not reuse the existing synthetic host-terminated completion as proof
of remote termination. Do not add automatic execution retries, crash resume or
step-output replay in this transport.

Cancellation remains a separate application-to-executor capability. Distinguish
requesting cancellation from observing termination. Rejecting late event writes
does not itself stop remote user code. Idempotently accept repeated failure
reports from the same attempt and never let them overwrite a committed terminal
result. Bound and sanitize transport diagnostics independently from trace data.

## Validation and delivery gates

This extraction must pass the existing Cloudflare alarm, reconciliation, tracing
and real-workerd tests unchanged in behavior. Exercise the shared runner with a
non-Cloudflare output/cwd and execution budget, and exercise registry transactions
with an independent SQLite adapter. Expand runtime-graph checks to every hosting
module: no Cloudflare/platform imports, concrete stores or Node listener assets.
Keep public exports and declarations unchanged apart from generated path hashes.

Before shipping HTTP ingestion, connect and test all of the following together.
The persistence operations above cover the storage portion, not the full path:

1. A concrete independent executor using persisted admission/attempt fencing.
2. Launch-scoped credential issuance, verification, expiry/revocation and redaction.
3. Atomic replay digests and durable run/descendant ownership, including concurrent
   duplicate requests, altered retries, sequence gaps and transaction rollback.
4. Bounded parsing, invalid-event rejection, lost-ack retries and no redirect/token
   leakage through client, server or logging paths.
5. Lost-contact and cancellation history that never claims confirmed termination
   or silently retries execution.
6. A real worker-to-collector integration that survives collector restarts and
   renders the resulting run tree in Studio.

Keep #289 open for that transport work. This change completes the ownership
extraction and provides its design input; it does not claim that an external
executor can already stream events to deployed Studio.
