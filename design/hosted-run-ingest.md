# Hosted execution and remote event ingestion

Issue: [#289](https://github.com/chetmancini/tubeless/issues/289).

This change separates trusted hosted execution, launch coordination and storage
while preserving the public Cloudflare API. Owned-attempt persistence, credential
provisioning, a Fetch-native collector and a delivery client are implemented
internally. An internal Node host connects Studio launches to supervised one-shot
workers over HTTPS, including persisted cancellation and start acknowledgements.
The application supplies the catalog, authentication, listeners and storage. No
public deploy target, CLI command or package subpath is introduced.

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

`HostedRunCoordinator` consumes a typed `HostedRunDriver`: prepare a private
dispatch value, start it, atomically fail an unadmitted launch, and provide scoped
cancellation and live-run reads. It owns browser value validation and acknowledgement
waiters, not ingestion authority or SQL. `createTrustedHostedRun` supplies the
existing trusted store/executor policy and a separate RPC ingest capability.
The coordinator owns the catalog snapshot and validates its bounded start timeout
for every driver. Factories capture configuration before deferred preparation or
dispatch; caller mutation cannot change an existing host's deployment or workers.
Cloudflare arranges recovery before dispatch through `scheduleReconcile`; a scheduling
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
to bypass owner checks. Trusted liveness, cancellation lookup and reconciliation
queries exclude owned attempts, so Cloudflare's alarm policy cannot declare a
remote worker terminated. History readers still include both paths; the owner of
remote execution must supply its own cancellation and recovery policy. The
authenticated collector uses a separate store capability that rechecks credential
authority inside every write transaction. Do not mount `StudioIngest` as HTTP
merely by decoding requests into its interface.

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
and event tables keep their layout; the adapter adds attempt tables on open:

- `tubeless_attempts`: the unique launch/attempt association, expected pipeline and
  deployment IDs, winning worker invocation, claim time and revocation marker.
- `tubeless_attempt_runs`: globally unique root/descendant run bindings with stable
  pipeline and parent identities.
- `tubeless_attempt_batches`: exact-body SHA-256 digests and original root-run
  acknowledgements keyed by attempt and committed sequence. Store no extra copy
  of raw request bodies here.
- `tubeless_attempt_cancellations`: one retained cancellation marker per attempt,
  separate from run history and write-authority revocation.

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
Each append path loads and validates one launch snapshot before calling the
shared commit operation. Owned-event validation returns the bound root directly;
the attempt path does not re-enter the trusted high-water replay policy or
reinterpret an optional-root acknowledgement after writing.

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
target dispatch and supervisor recovery remain target-owned.

## Implemented internal HTTP transport

`createHostedCollector` returns a Fetch handler; `createHostedCollectorClient`
provides claim, ordered batch delivery and explicit failure reporting. Neither
opens a listener or chooses a platform. Keep this service separate from Studio's
browser/admin routes and credentials. It accesses only an already-created launch;
it cannot submit jobs,
select executable modules, cancel other runs, clear history, or read Studio data.
The application continues to own launch creation and executor supervision.

### Authority and provisioning

`provisionCollectorAttempt` generates a random 256-bit secret and 128-bit
credential ID, and atomically provisions the attempt and credential record.
Persist an HMAC-SHA-256 verifier bound to the credential ID, launch, attempt and
validity window; verify it using native Web Crypto. Store no bearer secret. Keep
the expected command/deployment identity and revocation marker on the associated
attempt. Pass the secret to the worker through the host's secret channel. Do not put it in trace events, job input
values, URLs, logs, or browser configuration.

Authenticate every request with `Authorization: Bearer <credential>` over HTTPS.
Bind the credential to exactly one launch and attempt. Do not accept Studio
gateway tokens or browser sessions as executor authority. Authenticate before
reading a body or looking up user-visible launch state. Use generic unauthorized
responses for missing, invalid, expired or mismatched authority. Reject redirects
on the client, omit CORS grants, and return `Cache-Control: no-store`.

Recheck expiry and revocation inside every control read and write transaction, including receipt
replays, after asynchronous body hashing. These checks also protect a request
whose credential was valid before body reading. A terminal launch may retain a narrow replay
window for acknowledging already-committed batches; it must not accept new work.
History retention must not delete active attempt/credential state. Never reuse a
launch ID or credential after history cleanup.

### Operations

Use the following paths on the separate collector, with a fresh
`x-tubeless-worker-id` header per client invocation. These routes are not mounted
in the current Studio server:

| POST path                         | Request                             | Successful response         |
| --------------------------------- | ----------------------------------- | --------------------------- |
| `/v1/launches/{launchId}/admit`   | `{ attemptId, deploymentId }`       | `{ admitted }`              |
| `/v1/launches/{launchId}/batches` | `{ attemptId, sequence, events }`   | `{ accepted: true, runId }` |
| `/v1/launches/{launchId}/failure` | `{ attemptId, failureId, message }` | `{ recorded }`              |
| `/v1/launches/{launchId}/control` | `{ attemptId }`                     | `{ cancelRequested }`       |

Version the transport independently from native trace events. For v1 writes,
validate the current version 3 event schema; accepting older recordings for reads
does not make them valid remote writes. Validate IDs, safe nonnegative integer
sequences, request shape and every event before entering a write transaction.
Bound UTF-8 bodies while streaming, even without `Content-Length`; initially cap
batches at 50 events and 1 MiB encoded bytes and failure messages at 8 KiB. Reject
oversized individual events rather than silently changing identity-bearing data.
The sender must split by both count and bytes and retain the exact encoded body
through retries. Keep these limits internal until real worker workloads, including large
definition snapshots, have been probed. Bound claim/control bodies and responses at 8 KiB
and failure envelopes at 64 KiB. Bound each request, including authentication and
response reading, at ten seconds; stop waiting on abort even when an injected
transport or stream ignores cancellation. A timeout does not undo a store commit.

Use 400 for invalid input, 401 for invalid/expired/revoked authority or a foreign
owner, 409 for altered retries, sequence gaps or invalid event ownership, 410 for
new batches on a closed attempt, 413 for size limits, and 503 for an unavailable
collector. Return 405 for unsupported methods, 415 for non-JSON requests and 408
for a request deadline. Return `{ admitted: false }` for a refused claim. Do not return stored event payloads in errors.
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
do not execute or provision a fresh attempt based on that timeout. The client
sends a claim once, and never retries it. Retry batch/failure delivery and control reads,
at most four sends with cancellable backoff and exact encoded bytes. Stop the
batch queue after an uncertain delivery rather than reusing its sequence.

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
result. Report failure only after the owner has observed its execution exit and
drain; the client never reports termination automatically on delivery failure.
Persist failure IDs, exact-body digests and their original boolean result in the
same transaction as synthetic subtree completions. Preserve that result after a
collector restart; reject changed reports and prevent all reports from replacing
an existing successful completion. A pre-root failure closes the launch without
inventing a run. Bound and sanitize transport diagnostics independently from trace data.

## Implemented supervised worker integration

`runCollectorJob` uses the authenticated client to claim exactly once before
loading application modules or parsing values. It owns a snapshot of job input,
reports the confirmed worker invocation to its supervisor, and calls the shared
`executeHostedRun` path for command execution, trace context, history bounds,
cooperative deadlines and final flushing. This path owns the final delivery
barrier and returns absent, partial, complete, or unconfirmed history only after
draining; only a matching root completion can establish complete history. The
trusted Cloudflare wrapper retains
its existing admission, retry and failure policy. The remote wrapper batches with
zero outer retries; only the HTTP client retries delivery. A failed delivery
poisons the ordered queue and requests cooperative cancellation.

Keep execution and delivery cancellation separate: cancelling a command must
still allow its terminal history to flush. Return refused, history-confirmed or
unconfirmed to the supervisor; it tracks claim ownership separately. Do not promote a
delivered root start to terminal-history confirmation. Never turn lost contact, setup
failure or a returned command promise into a synthetic termination report from
inside the runner.

`startCollectorWorker` in `workbench/collector-worker.ts` supervises a fresh Node
process for one already-provisioned job. The trusted host supplies a compiled
module, optional export name, working directory and deployment revision; job values
never select executable code. The private IPC packet carries the credential
separately from application values, argv, environment and logs. The fixed runtime
selects a pipeline or explicit pipeline command only after a confirmed claim.
Application output goes through trace history; raw child stdio is not forwarded.
Start the compiled runtime with an empty `execArgv`; parent eval, print and preload
CLI arguments must not replace or run ahead of that bootstrap.

Bound startup/claim separately from post-claim execution. Default startup to
30 seconds and cooperative cancellation grace to one second. Arm the execution
watchdog on a confirmed claim so application module loading is also covered.
`cancel()` acknowledges a request; `completed` waits for process closure. If
cancellation is ignored, force `SIGKILL` after the grace period. After observing
closure, the parent may submit an owner-scoped failure report using its independent
delivery lifetime. Preserve a successful terminal event and replay a lost failure
reply with the same failure ID/body. Use the collector transport's typed
failure-report operation to validate and encode one request identity/body for both
the stateful client and platform supervisors. Return an unconfirmed report outcome when
delivery fails or no owner was confirmed; never provision another attempt or
retry execution automatically.

This supervision covers the direct worker process, not detached child processes
or external effects. Parent death, uncertain dispatch and a lost claim reply still
require target-owned recovery. An IPC disconnect requests cooperative abort; it
does not prove termination. This is an internal adapter, not a sandbox, durable
queue, crash-resume mechanism, or deployment selected for users.

## Persisted cancellation for owned attempts

The trusted host calls `requestAttemptCancellation(launchId, attemptId)` to persist
intent atomically for an open, unrevoked owned attempt. Repeated requests return
true while it remains open; unknown, mismatched, revoked or terminal attempts
return false. A request fences future claims without changing admission, history,
credentials or the launch's terminal state. Already-admitted workers retain write
authority so they can flush cancellation history. The marker survives a collector
restart and is never cleared to authorize another execution.

The owner-scoped `control` operation reads that marker. Require the claiming
worker and recheck credential validity and revocation inside the storage
transaction, after body reading. This endpoint cannot request cancellation or
read another attempt's control state. Keep host cancellation authority outside
the worker credential and outside the Studio browser protocol.

After a confirmed claim, the Node supervisor reads control immediately and then
one second after each settled read, with no overlapping polls. A true response
uses its existing cooperative cancellation and forced-exit grace. Stop polling
and abort pending control reads on local cancellation or process closure; keep
failure reporting on its independent delivery lifetime. Failed reads neither
cancel execution nor record failure; the existing hard execution deadline still
applies during an outage. Revoking credentials alone does not request cancellation.

A persisted request acknowledges intent, not delivery or termination. Before
claim, it prevents execution but leaves an unstarted launch for target-owned
resolution. After claim, only the worker's delivered terminal history or observed
process closure can establish its outcome. Production admin routing, dispatch,
supervisor recovery and process-tree policy remain target responsibilities.

## Studio-to-worker host composition

`createCollectorHostedRun` supplies the owned-attempt driver and a separate
authenticated collector. Validate the submitted command values before provisioning
an attempt and credential. Keep the bearer secret only in the private dispatch
packet; persist its verifier, expected pipeline and deployment identity atomically.
Accept a browser launch only after a committed batch returns its root run ID.
Claim acknowledgement or a successful fork alone does not acknowledge a Studio
run. Replayed batches retain the same persisted acknowledgement after a lost reply.
A committed supervisor failure can settle a pending pre-root launch without
inventing a run ID. A lost claim reply remains uncertain until the bounded start
wait expires; neither dispatch nor execution is retried automatically.

`createCollectorWorkerHost` in `workbench/collector-worker-host.ts` wires this driver
to the existing Node supervisor. Supply one explicit command/module catalog,
deployment ID, HTTPS collector URL, worker environment/cwd and execution budgets.
The host normalizes process budgets before provisioning and sizes credentials for
startup, execution, cancellation grace and final failure-report delivery. Modules
come only from the trusted catalog. Snapshot host configuration and submitted values before asynchronous
provisioning; keep credentials out of browser responses, application values and logs.

The factory returns separate `studio` and `collector` Fetch handlers, plus `drain`
and `close`. Require an explicit Studio authentication callback. The application
serves the collector separately with TLS and executor credentials; Studio session
authority grants no collector access, and worker credentials grant no Studio
access. The host does not open listeners or own the supplied store.

Owned liveness and run-based cancellation are scoped to the configured deployment
and top-level root. They exclude trusted runs, foreign deployments and child run
IDs. Request cancellation atomically against a running owned root; delivered
terminal history remains authoritative. These queries do not widen Cloudflare's
trusted cancellation or stale-launch recovery policy.

`drain` awaits current dispatch tasks and supervised worker completion. `close`
first closes Studio admission and settles pending browser responses, prevents delayed
preparation from dispatching, cancels active workers, then drains. Keep listeners
and storage available through final worker delivery and close storage afterward.
A start-response timeout leaves dispatch observed and allows a late persisted
start; host closure prevents that late dispatch. Storage operations remain
caller-owned and must settle before shutdown can drain them safely.

This is a process-owned integration. Production routing, durable dispatch,
supervisor restart recovery and resolution of cancelled unclaimed launches remain
target-owned. Restarting a host can read persisted history and cancellation state;
it does not recover process handles or prove an older worker terminated.

## Validation and delivery gates

Preserve the existing Cloudflare alarm, reconciliation, tracing and real-workerd
tests. Keep every hosting module free of Cloudflare/platform imports, concrete
stores and Node listeners. Check the emitted worker entrypoint independently: it
may select commands but must not reach CLI startup or concrete storage. Keep
public exports and declarations unchanged apart from generated hashes.

Transport tests cover real SQLite through the client and Fetch handler, including
lost replies after commit, exact byte retries, count/byte splitting, authentication
before body reading, expiry/revocation races, failed receipt rollback, collector
reopen, bounded streams/responses, and uncooperative cancellation.

Worker integration tests use separate OS processes and real HTTPS with a private
test CA, keeping TLS verification enabled. Exercise duplicate dispatch and late
redelivery, refusal before module loading, lost claim replies, collector/SQLite
reopen after a committed batch whose reply was lost, nested history through Studio,
eval/print parent launchers, partial root history, cooperative cancellation, hung
module loading, hard termination, lost contact
without false terminal history, and failure-report retries after observed exit.
Exercise cancellation before claim, intent surviving collector restart, control
outages, hung workers and aborted control reads with late transport failures.
Drive Studio launch/live/cancel requests through the Node host and real HTTPS
worker delivery, including a lost batch reply and a lost claim, pre-root failure,
input validation before provisioning, authority separation, shutdown, and history
after reopening storage. Verify deployment-scoped owned controls independently of
trusted cancellation and stale-launch queries.
Probe real nested definition snapshots: accept ordinary recordings and reject an
oversized child snapshot without altering its identity or inventing child history;
preserve and close the already-recorded root after worker exit.

Keep #289 open for production target wiring and recovery. Before production use:

1. Mount the collector separately from Studio admin/browser routes and provision
   credentials through the chosen target's secret channel.
2. Integrate durable dispatch, parent/process lifecycle recovery and cancellation
   ownership; retain launch/attempt IDs after uncertain dispatch.
3. Choose target-specific policy for process trees, remote effects and retained
   attempt/credential state.
4. Probe target workloads before publishing transport limits as a public contract.

No new public package subpath, CLI command or production route is introduced.
