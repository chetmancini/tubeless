# Remote-step composition

Use `step.fromRemote` when a pipeline step needs to call a service or execution
engine outside the current process. The step sends input through an adapter,
waits for the result, and validates it before dependent steps run.

The required fields are `adapter`, `mapInput`, and `outputSchema`:

- `adapter.invoke` sends the request and returns the remote result.
- `mapInput` builds the request from local step inputs and context.
- `outputSchema` checks the returned value and provides its type to dependents.

Use `fromRemote.skippable` when the request may be intentionally omitted. As
with other skippable steps, dependent code must handle a possible `undefined`.
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

## Invoke a pipeline from a worker

[`host-embedding.ts`](../examples/host-embedding.ts) exports `handleHostJob` for a
queue worker or activity handler. It passes the host-owned `correlationId`, an
optional known Tubeless `parentRunId`, `dryRun`, and `signal` to `runOrThrow`.
Failed or cancelled runs reject, allowing the host to withhold acknowledgement
and apply its failure policy. Validate the job envelope before invocation; keep
host SDKs and persistence outside the pipeline module.
