# Remote-step composition

## What ships

Compose a remote engine as one typed parent step with
`createSteps<TOptions>().fromRemote(...)`. The factory builds an ordinary step
whose `run` maps input and calls `RemoteStepAdapter.invoke`. Overloads cover
required `adapter`, `mapInput`, and `outputSchema`. Optional
`fromRemote.skippable` widens dependents the same way as `fromPipeline.skippable`.

One opaque parent step stays in the parent plan. `executePlannedRun` does not
learn about engines; disposition, output validation, hooks, and reports apply
unchanged.

## Two compositions

| Need                                                                  | Composition                                                                                                                              | Who drives the DAG   | Who survives process death                        |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | ------------------------------------------------- |
| The graph must outlive the process, sleep for days, or wait on humans | Host embedding: a Temporal workflow, Lambda handler, or queue worker calls `pipeline.runOrThrow(...)` and passes `runId` / `parentRunId` | The engine           | The engine                                        |
| Some steps run elsewhere; the rest stay local                         | `fromRemote`: one opaque parent step per remote unit of work                                                                             | The tubeless process | Only the remote job, not the parent `PipelineRun` |

These are complementary. A host can persist job delivery and retry a whole
invocation; calling `runOrThrow` does not checkpoint the graph. Put arbitrary
pipeline I/O in an activity or worker handler, not a replayed workflow body.
The host owns durable orchestration, idempotency, retries, and acknowledgements.
Neither correlation IDs nor a remote invoker provide crash-resume.

## Adapter mapping

`RemoteStepAdapter.invoke(payload, context)` is request/response. Temporal
start-then-`result()`, Lambda invoke, HTTP RPC, and a queue that blocks until
the job finishes all live inside the adapter.

The adapter maps:

- `context.signal` to cancel
- `context.reportProgress` to heartbeats or status polls
- `context.log` to remote output when the engine can stream or poll it
- `context.dryRun` to the engine's side-effect gate
- remote failures to a thrown `Error` with optional `cause` and `code`

`PipelineStepContext` does not grow a `stepId` field. Job ids come from the
`fromRemote("id", …)` call site, usually via `mapInput`.

## Inverse dry-run contract

Omitting `dryRun` on `fromRemote` means the adapter is contacted during a
pipeline dry run. That makes this adapter-side rule the only safety line:

- When `context.dryRun === true`, `invoke` must not produce side effects.
- The remote worker must treat the same flag the same way.
- The kernel does not inject `dryRun` into the payload and does not inspect
  the engine. Authors prove the flag crossed the boundary by putting
  `dryRun: ctx.dryRun` (or the engine's equivalent) in `mapInput`.
- There is no way to call `invoke` while lying about dry-run.
  `context.dryRun` is the pipeline's actual flag.

| Author writes                | Meaning                                    | Pipeline dry run                         |
| ---------------------------- | ------------------------------------------ | ---------------------------------------- |
| omit                         | Work is safe, or the engine honors dry-run | Call `invoke`; `context.dryRun === true` |
| `dryRun: "skip"`             | This work is the side effect               | Do not call `invoke`                     |
| `dryRun: (inputs, ctx) => …` | A local preview is enough                  | Call the handler only                    |

Authors do not write `dryRun: "run"`. That token is not part of the authoring
surface.

## Local visibility

Remote work stays one opaque parent step. Local studio, hooks, and the TTY
already observe that step.

**Logs are optional.** If the engine can stream or poll output while
`invoke` is in flight, the adapter calls `context.log.log` / `warn` /
`error` as lines arrive. If the engine has no stream, skip it.

**Exceptions are required.** Do not swallow a remote failure. Rethrow an
`Error`. Wrap the remote object as `cause`. Copy a machine `code` onto the
thrown error when the engine has one. Cancellation still goes through
`context.signal`. No `TUBELESS_REMOTE_*` codes and no `streamLogs` flag on
`fromRemote`.

**Progress is the latest heartbeat; logs are the append-only narrative.**
Use `context.reportProgress` for status and a job-id detail row. Use
`context.log` for lines. Both can run together.

## Non-goals

- A placement driver that compiles the DAG into a Temporal workflow.
- Official Temporal, AWS, or HTTP SDKs in the kernel.
- Flattening remote activity, workflow, or request IDs into the parent DAG.
- Injected runner overrides (same rejection as child pipelines).
- `fromRemote` `mapResult`. Reshape in the adapter or a later local step.

## Executable HTTP boundary

[`remote-steps.ts`](../examples/remote-steps.ts) uses native `fetch`, with no
provider dependency. Call `runRemoteStepsExample("http://127.0.0.1:8080")` against
a service implementing this application-owned protocol:

- `POST /enrich`, JSON body `{ rows: string[], runId: string, dryRun: boolean }`.
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
service that starts durable jobs needs its own cancellation protocol. Automatic
retries are deliberately absent: the service must define idempotency before
retrying a request that may already have committed.

The integration tests in `src/testing/remote-steps.example.test.ts` use a real
loopback server, covering live and dry-run requests, invalid output, malformed
JSON, HTTP errors, and an aborted in-flight connection. The packed-artifact check
also runs the recipe over HTTP without credentials or an external service.

## Separate host handler

[`host-embedding.ts`](../examples/host-embedding.ts) exports `handleHostJob` for a
queue worker or activity handler. It passes host-owned `runId`, `parentRunId`,
`dryRun`, and `signal` to `runOrThrow`. Failed or cancelled runs reject, allowing
the host to withhold acknowledgement and apply its failure policy. Assign a
unique run ID per invocation/attempt and a stable parent workflow ID. Validate
the job envelope before invocation; keep host SDKs and persistence outside the
pipeline module.
