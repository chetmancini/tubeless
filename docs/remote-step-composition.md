# Remote-step composition

For a complete engine integration in both directions, see [Tubeless ↔ Airflow](./airflow.md).
For durable hosting in an Activity, see [Tubeless on Temporal](./temporal.md).
For asset materialization through Dagster Pipes, see [Tubeless on Dagster](./dagster.md).

Use `fromRemote` when a pipeline step needs to call a service or execution
engine outside the local handler, including a Node worker thread. The step sends input through an adapter,
waits for the result, and validates it before dependent steps run.

The required fields are `adapter`, `mapInput`, and `outputSchema`:

- `adapter.invoke` sends the request and returns the remote result.
- `mapInput` builds the request from local step inputs and context.
- `outputSchema` checks the returned value and provides its type to dependents.

Add `skip` to the `fromRemote` definition when the request may be intentionally
omitted. As with other skippable steps, dependent code must handle `undefined`
when any skip branch omits its value. If every branch supplies a value matching
the output schema's input, dependents retain the transformed output type.
See the [HTTP example](../examples/remote-steps.ts) for a complete implementation.

## Choose where the pipeline runs

There are two ways to combine Tubeless with an external execution system:

| Need                                                           | Approach                                                     | What Tubeless runs                        |
| -------------------------------------------------------------- | ------------------------------------------------------------ | ----------------------------------------- |
| A worker or durable system should own job delivery and retries | Call `pipeline.runOrThrow` from a worker or activity handler | The whole pipeline inside that invocation |
| One part of a local pipeline should run elsewhere              | Use `fromRemote` for that step                               | The parent pipeline in the local process  |

A remote step remains one step in the parent plan. Its remote engine and target
metadata describe where work is sent; they do not move the parent graph to that
engine. If the local process exits, a remote job may continue, but the parent
run is not automatically restored.

For host-owned execution, the host must provide persistence, retries,
idempotency, and acknowledgement. Calling `runOrThrow` does not checkpoint the
pipeline. In a durable engine with replayed workflow code, put pipeline I/O in
an activity or worker handler. Use `correlationId` for the host's reusable job
identity. Use `parentRunId` only to link a known Tubeless execution; these
identities do not provide crash recovery.

## Adapter mapping

`RemoteStepAdapter.invoke(payload, context)` must return the completed remote
result. If the service starts a job asynchronously, the adapter must also wait
for or poll that job before returning.

Use the supplied context to connect local controls to the remote operation:

- `context.signal` to cancel requests or send a remote cancellation request
- `context.reportProgress` to heartbeats or status polls
- `context.log` to remote output when the engine can stream or poll it
- `context.dryRun` to the remote service's preview mode
- remote failures to a thrown `Error` with optional `cause` and `code`

If the remote request needs a step or job ID, include it in `mapInput`.
`PipelineStepContext` has no `stepId` field.

## Dry-run behavior

Omitting `dryRun` on `fromRemote` means the adapter is contacted during a
pipeline dry run. To make that safe:

- When `context.dryRun === true`, `invoke` must not produce side effects.
- The remote worker must treat the same flag the same way.
- Include `dryRun: ctx.dryRun`, or the service's equivalent, in `mapInput`.
  Tubeless passes the flag in the adapter context but does not add it to the
  remote request payload. Test that the remote service receives and honors it.

| Author writes                | Meaning                                    | Pipeline dry run                         |
| ---------------------------- | ------------------------------------------ | ---------------------------------------- |
| omit                         | Work is safe, or the engine honors dry-run | Call `invoke`; `context.dryRun === true` |
| `dryRun: "skip"`             | This work is the side effect               | Do not call `invoke`                     |
| `dryRun: (inputs, ctx) => …` | A local preview is enough                  | Call the handler only                    |

To use the normal handler during a dry run, omit the policy.
`dryRun: "run"` is not a supported configuration value.

## Logs, progress, and errors

The CLI, Studio, and parent hooks observe the remote call as one local step.
Use `context.reportProgress` for current status, such as a job ID or percentage
complete. If the service provides logs, forward them through
`context.log.log`, `warn`, or `error`. Logs and progress can be reported together.

Throw an `Error` when remote work fails. Include the original error as `cause`
and preserve its machine-readable `code` when available. Cancellation uses
`context.signal`. Tubeless does not supply remote-provider-specific error codes
or a separate log-streaming option.

Keep provider SDKs in the application adapter. To reshape the result, transform
it in the adapter or in a later local step; `fromRemote` has no `mapResult`.
Remote activity and request IDs do not become steps in the parent graph.

## Implement an HTTP adapter

[`remote-steps.ts`](../examples/remote-steps.ts) uses native `fetch`, with no
provider dependency. Call `runRemoteStepsExample("http://127.0.0.1:8080")` against
a service implementing this application-owned protocol:

- `POST /enrich`, JSON body
  `{ rows: string[], parentRunId: string, correlationId?: string, dryRun: boolean }`.
- Success: a 2xx JSON response `{ orderId: string, rows: string[] }`.
- Failure: a non-2xx status. The adapter throws with code `HTTP_<status>` and a
  status cause, without copying response bodies into diagnostics.

The service must validate the request and gate all writes on `dryRun`. A pipeline
dry run still sends this request. If the service cannot guarantee a side-effect-free
preview, add `dryRun: "skip"` or a local preview handler instead.
`outputSchema` checks the object and every row before the local summary step runs;
malformed JSON and invalid output fail the step. Customize authentication and
endpoint configuration in the application adapter.

Cancellation passes the caller signal through to `fetch`, aborting the HTTP wait.
It does not guarantee that the server stopped work or rolled back writes. A
service that starts durable jobs needs its own cancellation protocol. The example does not retry automatically: the service must define idempotency before
retrying a request that may already have committed.

Test live and dry-run requests, invalid response data, malformed JSON, HTTP
errors, and cancellation of an in-flight request. The example's integration
tests use a local HTTP server so they need no credentials or external service.

## CPU work in Node worker threads

`maxConcurrency` overlaps asynchronous steps, but synchronous CPU-heavy handlers
still block the pipeline's event loop. Use `createWorkerThreadAdapter` from
`tubeless/node` to run an explicit module export on another thread:

```ts
import { createWorkerThreadAdapter } from "tubeless/node";

const adapter = createWorkerThreadAdapter({
  module: new URL("./image-worker.js", import.meta.url),
  exportName: "resize",
  poolSize: 4,
});
```

Pass this adapter to `fromRemote`, build its payload with `mapInput`, and supply
`outputSchema` as usual. The adapter returns `unknown`; the schema validates it
on the parent thread before any dependent consumes it. Nothing moves an arbitrary
`step.run` closure into a worker. The export must be a function accepting
`(payload, context)`; it may return a value or a promise. Compile TypeScript worker
modules to JavaScript for Node. File and data URLs are supported; module loading
and missing/non-function exports reject the invocation.

The [worker recipe](../examples/worker-threads.ts) and its
[CPU function](../examples/prime-worker.ts) demonstrate four independent prime
counts. The worker can import `WorkerThreadContext` as a type from `tubeless/node`.
Its context contains `signal`, `log`, `reportProgress`, `cwd`, `dryRun`, `runId`,
`attemptId`, and optional `correlationId` / `parentRunId`. Domain options, closures,
hooks, schemas, and the parent's logger object do not cross the boundary. Include
needed domain values in `mapInput`. `cwd` is metadata; it does not change the
worker's process working directory. Resolve relative paths explicitly.

Payloads are snapshotted with structured clone when invoked, even if queued.
Results cross the same boundary. Maps, dates, typed arrays, and cloneable objects
are supported; functions are not. No transfer list is used, so ArrayBuffers are
copied rather than detached. SharedArrayBuffers remain shared if explicitly
supplied. Module globals are private to each worker and persist across invocations;
workers are not a security sandbox.

The adapter creates workers lazily, reuses them, and runs one invocation per worker.
`poolSize` is a positive integer defaulting to `1`; excess invocations queue in FIFO
order. Sharing one adapter across steps or runs shares that pool limit. Separate
adapters own separate pools. Set the pipeline's `maxConcurrency` high enough to
admit the desired number of calls; a four-thread pool with serial DAG execution
still handles only one step at a time. Idle workers do not keep Node alive.

Worker `context.log` messages are formatted in the worker and sent to the parent
step's logger. `reportProgress` forwards the snapshot to the same step. Within one
invocation messages keep send order; different workers interleave as messages
arrive. Late callbacks from a finished invocation are dropped. Use the supplied
logger rather than `console` to preserve step attribution. Thrown errors retain
their message, name, stack, string/number code, and up to five nested causes.
Invalid output, thrown errors, and worker exits fail the owning step; the adapter
never retries work automatically. A crashed worker is replaced for later calls.

External cancellation removes queued calls immediately. Active calls receive a
cancel message that aborts the worker context's signal. Once cancellation is
observed by the adapter, that invocation rejects with `AbortError` even if its
handler subsequently returns a value. By default it allows 100 ms for cooperative
cleanup (`cancelTimeoutMs` overrides this); then it terminates the worker and waits
for its exit before settling the invocation or reusing the pool slot. A synchronous
loop cannot receive messages while blocked, so it requires this termination path.
Forced termination may interrupt cleanup; await all work owned by the handler,
and make external writes safe for interruption. Cancellation does not roll back
side effects. Fail-fast alone sends no cancellation: already-active worker calls
still settle under the pipeline's normal failure semantics.

Call `await adapter.close()` when its owner is done, normally in `finally` after
all callers have settled. Closing rejects queued calls, terminates active and idle
workers, and waits for their exit. It is idempotent; subsequent invocations reject.
Do not close a shared adapter while other callers still need it. The worker recipe
exports a shared `primeAdapter`: repeated `runWorkerThreadsExample()` calls and
direct `WorkerPrimesPipeline` runs reuse it. The application calls
`await primeAdapter.close()` at shutdown, after all those runs settle.

The adapter always forwards `dryRun` in the worker context, but it does not suppress
writes itself. Use `dryRun: "skip"`, a local preview handler, or a worker function
that honors `context.dryRun`. Pure CPU computation can run in either mode.

## Invoke a pipeline from a worker

[`host-embedding.ts`](../examples/host-embedding.ts) exports `handleHostJob` for a
queue worker or activity handler. It passes the host-owned `correlationId`, an
optional known Tubeless `parentRunId`, `dryRun`, and `signal` to `runOrThrow`.
Failed or cancelled runs reject, allowing the host to withhold acknowledgement
and apply its failure policy. Validate the job envelope before invocation; keep
host SDKs and persistence outside the pipeline module.
