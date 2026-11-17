# Remote-step composition

Use `fromRemote` when one step of a pipeline should call a service or execution
engine outside the local handler, including a Node worker thread. The step sends
input through an adapter, waits for the result, and validates it before dependent
steps run. Complete engine integrations: [Airflow](./airflow.md),
[Inngest](./inngest.md), [Temporal](./temporal.md), [Dagster](./dagster.md) and
[AWS Step Functions](./step-functions.md).

Required fields:

- `adapter.invoke` sends the request and returns the completed remote result (it
  must wait for or poll asynchronous jobs).
- `mapInput` builds the request from local step inputs and context.
- `outputSchema` validates the result and types it for dependents.

Add `skip` when the request may be intentionally omitted; dependents then handle
`undefined` unless every branch supplies a value. See the
[HTTP example](../examples/remote-steps.ts).

## Choose where the pipeline runs

| Need                                                           | Approach                                                     | What Tubeless runs                        |
| -------------------------------------------------------------- | ------------------------------------------------------------ | ----------------------------------------- |
| A worker or durable system should own job delivery and retries | Call `pipeline.runOrThrow` from a worker or activity handler | The whole pipeline inside that invocation |
| One part of a local pipeline should run elsewhere              | Use `fromRemote` for that step                               | The parent pipeline in the local process  |

A remote step stays one step in the parent plan, and the parent is not restored if
the local process exits (the remote job may continue). For host-owned execution the
host provides persistence, retries, idempotency and acknowledgement; `runOrThrow`
does not checkpoint. In engines that replay workflow code, put pipeline I/O in an
activity or worker handler. Use `correlationId` for the host's job identity and
`parentRunId` only to link a known Tubeless execution.

[`host-embedding.ts`](../examples/host-embedding.ts) exports `handleHostJob` for a
queue worker or activity handler. Failed or cancelled runs reject, so the host can
withhold acknowledgement and apply its failure policy. Validate the job envelope
first and keep host SDKs outside the pipeline module.

## Adapter mapping

`RemoteStepAdapter.invoke(payload, context)` maps local controls to the remote
operation:

- `context.signal`: cancel requests or send a remote cancellation.
- `context.reportProgress`: heartbeats or status polls.
- `context.log`: remote output, when the engine can stream or poll it. The CLI,
  Studio and parent hooks see the whole call as one step.
- `context.dryRun`: the service's preview mode.
- Failures: throw an `Error` with optional `cause` and `code`.

Put any step or job ID in `mapInput`; `PipelineStepContext` has no `stepId`. Keep
provider SDKs in the adapter and reshape results there or in a later step (there is
no `mapResult`).

## Dry runs

Omitting `dryRun` on `fromRemote` means the adapter is called during a pipeline dry
run, so `invoke` must have no side effects when `context.dryRun === true` and the
remote worker must honor the same flag. Tubeless does not add the flag to the
payload: include `dryRun: ctx.dryRun` (or the service's equivalent) in `mapInput`
and test that the service honors it.

| Author writes                | Meaning                                    | Pipeline dry run                         |
| ---------------------------- | ------------------------------------------ | ---------------------------------------- |
| omit                         | Work is safe, or the engine honors dry-run | Call `invoke`; `context.dryRun === true` |
| `dryRun: "skip"`             | This work is the side effect               | Do not call `invoke`                     |
| `dryRun: (inputs, ctx) => …` | A local preview is enough                  | Call the handler only                    |

## HTTP adapter

[`remote-steps.ts`](../examples/remote-steps.ts) uses native `fetch`. Call
`runRemoteStepsExample("http://127.0.0.1:8080")` against a service implementing this
application-owned protocol:

- `POST /enrich` with JSON `{ rows: string[], parentRunId: string, correlationId?: string, dryRun: boolean }`.
- Success: 2xx JSON `{ orderId: string, rows: string[] }`.
- Failure: non-2xx; the adapter throws with code `HTTP_<status>` and no response body.

The service must validate the request and gate writes on `dryRun`; if it cannot
guarantee a side-effect-free preview, use `dryRun: "skip"` or a local preview
handler. Malformed JSON and invalid output fail the step.

Cancellation aborts the `fetch` wait but does not guarantee the server stopped or
rolled back; a service that starts durable jobs needs its own cancellation
protocol. The example never retries, so define idempotency before adding retries.

## CPU work in Node worker threads

`maxConcurrency` overlaps asynchronous steps, but synchronous CPU-heavy handlers
block the event loop. Use `createWorkerThreadAdapter` from `tubeless/node` to run an
explicit module export on another thread:

```ts
import { createWorkerThreadAdapter } from "tubeless/node";

const adapter = createWorkerThreadAdapter({
  module: new URL("./image-worker.js", import.meta.url),
  exportName: "resize",
  poolSize: 4,
});
```

Pass it to `fromRemote` with `mapInput` and `outputSchema` as usual; the schema
validates the result on the parent thread. See the [worker recipe](../examples/worker-threads.ts)
and its [CPU function](../examples/prime-worker.ts).

- **Module:** the export is a function `(payload, context)` returning a value or
  promise. Compile TypeScript workers to JavaScript; import `WorkerThreadContext` as a
  type from `tubeless/node`. Use its `log`, not `console`, to keep step attribution.
- **Boundary:** the worker context has `signal`, `log`, `reportProgress`, `cwd`,
  `dryRun`, `runId`, `attemptId` and optional `correlationId` / `parentRunId`.
  Closures, hooks, schemas, options and the parent logger do not cross; put needed
  domain values in `mapInput`. `cwd` is metadata only, so resolve paths explicitly.
- **Data:** payloads and results use structured clone (maps, dates and typed arrays
  work, functions do not). ArrayBuffers are copied, not transferred. Module globals
  persist per worker; workers are not a security sandbox.
- **Pool:** workers are created lazily and run one invocation at a time.
  `poolSize` defaults to `1`; extra calls queue FIFO. A shared adapter shares its
  pool across steps and runs. Raise `maxConcurrency` too, or serial DAG execution
  still uses one thread. Idle workers do not keep Node alive.
- **Errors:** thrown errors keep message, name, stack, code and up to five nested
  causes. Invalid output, errors and worker exits fail the step; nothing retries,
  and a crashed worker is replaced.
- **Cancellation:** queued calls are removed immediately. Active calls get a cancel
  message that aborts the worker's `signal`, and the invocation rejects with
  `AbortError` even if the handler later returns. After 100 ms (`cancelTimeoutMs`)
  the worker is terminated, which is the only path for a blocked synchronous loop.
  Termination may interrupt cleanup and does not roll back side effects.
- **Dry runs:** `dryRun` is forwarded, but the adapter does not suppress writes.
  Use `dryRun: "skip"`, a local preview handler, or honor `context.dryRun` in the
  worker.

Call `await adapter.close()` in `finally` once all callers settle (do not close a
shared adapter others still use). It rejects queued calls, terminates workers, and is
idempotent; later invocations reject. The recipe exports a shared `primeAdapter` for
the application to close at shutdown.
