# Tubeless on Temporal

Run a Tubeless pipeline inside a Temporal Activity. Temporal owns durable
orchestration, task delivery, and retries; Tubeless owns the typed steps,
progress, and execution report within each Activity attempt.

Keep the pipeline out of Workflow code. Temporal replays Workflows to recover
their state, while Tubeless executes ordinary application code with process-local
state and generated execution IDs. A Workflow should schedule the Activity and
await its result. See Temporal's
[TypeScript application guide](https://docs.temporal.io/develop/typescript/core-application).

```text
Client → Temporal Workflow → Activity → Tubeless pipeline
```

## The example

| File                                                  | Responsibility                                                                       |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------ |
| [`pipeline.ts`](../examples/temporal/pipeline.ts)     | Normalize and deduplicate rows using public Tubeless imports                         |
| [`activities.ts`](../examples/temporal/activities.ts) | Validate the job and bridge Activity cancellation, heartbeats, logs, and correlation |
| [`workflows.ts`](../examples/temporal/workflows.ts)   | Schedule the Activity with timeouts and a retry policy                               |
| [`worker.ts`](../examples/temporal/worker.ts)         | Register the Workflow and Activity on a task queue                                   |
| [`client.ts`](../examples/temporal/client.ts)         | Start a Workflow and await its pipeline result                                       |

The pipeline has no Temporal imports. The Workflow imports Activity **types**
only, so the Activity implementation and Tubeless runtime stay outside the
Workflow bundle. These examples use Temporal TypeScript SDK 1.24.0, installed
as development dependencies in this repository. Applications adopting the
example install the Activity, Client, Worker, and Workflow SDK packages in their
own project; Tubeless itself has no runtime dependency on Temporal.

## Run locally

Use Node.js 22.6 or later to run the Temporal Worker and Client. Bun installs
the repository dependencies and builds the package, but the Worker runs under
Node.js.

From the repository root:

```sh
bun ci
bun run build
bunx tsc -p examples/temporal/tsconfig.build.json
```

The example compiler writes JavaScript to `.context/temporal/`. Install the
[Temporal CLI](https://docs.temporal.io/cli/setup-cli), then start a development
server in another terminal:

```sh
temporal server start-dev --db-filename .context/temporal-dev.db
```

The SQLite file preserves development server state between starts. The default
service address is `localhost:7233`, and the Web UI is at
`http://localhost:8233`. See the
[development server reference](https://docs.temporal.io/cli/server).

Start the Worker from the repository root:

```sh
node .context/temporal/worker.js
```

In another terminal, start the Workflow:

```sh
node .context/temporal/client.js
```

The Client prints the Workflow ID, then a result containing `rows: ["alpha",
"beta"]`, `count: 2`, a Tubeless `runId`, and `preview: false`. Open
`tubeless-normalize-demo` in Temporal's UI to inspect the Workflow and Activity.
The Worker logs contain the individual Tubeless steps and trace events.

The Client uses a stable Workflow ID and `REJECT_DUPLICATE`. Running it again
with the same ID fails while that execution is retained, rather than silently
starting another copy. Choose another ID for an intentional new execution:

```sh
TEMPORAL_WORKFLOW_ID=tubeless-normalize-demo-002 node .context/temporal/client.js
```

Both scripts accept `TEMPORAL_ADDRESS` and `TEMPORAL_NAMESPACE`, defaulting to
`localhost:7233` and `default`. They show an unauthenticated local connection.
For Temporal Cloud, configure TLS and authentication on both `Connection` and
`NativeConnection` according to your deployment's
[connection requirements](https://docs.temporal.io/develop/typescript/temporal-client).
Keep credentials in the host configuration rather than Workflow inputs.

## Activity integration

[`runPipeline`](../examples/temporal/activities.ts) validates the incoming job
before starting Tubeless. Invalid rows or control metadata raise a non-retryable
`ApplicationFailure`: another attempt cannot fix malformed input.

The Activity calls `TemporalPipeline.runOrThrow` with its cancellation signal
and a correlation ID composed of namespace, Workflow ID, Workflow run ID, and
Activity ID. That correlation stays stable across Activity retries. Each
Tubeless attempt gets a fresh `runId`, which is also returned in the result.
Only a known Tubeless execution may be passed as `job.parentRunId`; a Temporal
Workflow run ID is a separate identity.

Tubeless progress hooks update the Activity heartbeat with step ID and progress
counts. A five-second timer also heartbeats while a step waits without reporting
progress, and the Activity clears that timer on exit. The SDK may throttle
heartbeats before sending them to the service. These details describe progress;
the example does not read them as checkpoints or resume completed steps.

The adapter sends pipeline logs and structured trace events through Temporal's
Activity logger. This gives operators Workflow, Activity, and Tubeless identities
in one log stream. Temporal's event history records the Activity boundary; it
does not turn every Tubeless step into a durable Temporal event. To inspect
remote step histories in Studio, replace or compose the example trace exporter
with a destination that retains raw Tubeless events. Worker log wrappers are
not an importable NDJSON trace. Apply your data redaction policy at that exporter.

## Retries and recovery

The Workflow configures a one-minute limit per Activity attempt, a five-minute
overall Activity limit including queueing and retries, a 15-second heartbeat
timeout, and at most three attempts. Ordinary execution failures escape the
Activity and use this retry policy. Invalid input bypasses retries.

An Activity retry executes the entire Tubeless pipeline again. Completed steps
are not individually checkpointed by Temporal. This example performs pure row
transformations, so repeating it is safe. If you add writes, use business-level
idempotency keys and account for overlapping attempts after timeouts. A heartbeat
does not make external side effects exactly-once.

For durable boundaries between expensive or independently retryable phases,
split the work into separate Temporal Activities, each of which can host a
smaller Tubeless pipeline. Keep Activity I/O out of Workflow code. See
[Activity timeouts and retries](https://docs.temporal.io/develop/typescript/failure-detection).

## Cancellation and dry runs

The Activity passes `Context.current().cancellationSignal` into Tubeless. Steps
must cooperate by forwarding `context.signal` into waits and I/O. Heartbeats
allow the Worker to receive cancellation requests from the service. Because
Tubeless wraps execution failures, the adapter restores Temporal's original
cancellation failure through `activity.cancelled` when the signal is aborted.
That prevents cancellation from becoming an ordinary retryable failure.

The Workflow uses `WAIT_CANCELLATION_COMPLETED` so it waits for Activity
cancellation to settle. To request cancellation of a running execution:

```sh
temporal workflow cancel --workflow-id tubeless-normalize-demo
```

The small sample usually finishes before a manual cancellation arrives. Tests
exercise cancellation during normalization. Cancellation is cooperative, not
rollback; blocking work or I/O that ignores the signal can delay completion.
Closing the Client while it awaits the result does not cancel the Workflow.
See Temporal's [Activity context reference](https://typescript.temporal.io/api/classes/activity.Context).

Pass `dryRun: true` in the job to forward Tubeless dry-run controls. That still
creates a real Workflow and Activity, emits logs, and sends heartbeats. Mark
application writes with `dryRun: "skip"` or a side-effect-free preview handler.
To preview the same pipeline without contacting Temporal, use its local project
registration:

```sh
bun run tubeless -- plan --project examples/project/tubeless.project.ts temporal-normalize
bun run tubeless -- run --project examples/project/tubeless.project.ts temporal-normalize -- \
  --lines " Alpha " --lines "Beta" --dry-run
```

This registration executes locally. Use the Temporal Client and Worker when
Temporal should own delivery and recovery.

## Verification

`make check` compiles the examples against the real SDK, runs the pipeline in
Temporal's `MockActivityEnvironment`, and bundles the Workflow using Temporal's
bundler. Tests cover progress heartbeats, timer cleanup, correlation across
attempts, invalid payloads, dry runs, cancellation, and execution failure
propagation. They require no Temporal service or credentials. Validate your
deployment's connectivity, authentication, worker shutdown, and side-effect
idempotency with its own integration tests.
