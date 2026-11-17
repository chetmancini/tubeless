# Tubeless on Temporal

Run a Tubeless pipeline inside a Temporal Activity. Temporal owns durable
orchestration, task delivery, and retries; Tubeless owns the typed steps,
progress, and execution report within each Activity attempt.

```text
Client → Temporal Workflow → Activity → Tubeless pipeline
```

Keep the pipeline out of Workflow code: Temporal replays Workflows, while
Tubeless runs ordinary application code with process-local state and generated
IDs. The Workflow schedules the Activity and awaits it
([TypeScript application guide](https://docs.temporal.io/develop/typescript/core-application)).

## The example

| File                                                  | Responsibility                                                                       |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------ |
| [`pipeline.ts`](../examples/temporal/pipeline.ts)     | The pipeline, with no Temporal imports                                               |
| [`activities.ts`](../examples/temporal/activities.ts) | Validate the job and bridge cancellation, heartbeats, logs, and correlation          |
| [`workflows.ts`](../examples/temporal/workflows.ts)   | Schedule the Activity with timeouts and a retry policy (imports Activity types only) |
| [`worker.ts`](../examples/temporal/worker.ts)         | Register the Workflow and Activity on a task queue                                   |
| [`client.ts`](../examples/temporal/client.ts)         | Start a Workflow and await its result                                                |

It uses Temporal TypeScript SDK 1.24.0. Your application installs the Activity,
Client, Worker, and Workflow SDK packages itself; Tubeless has no runtime
dependency on Temporal.

## Setup

The Worker and Client run under Node.js 22.18 or later (Bun only installs and
builds). Install the [Temporal CLI](https://docs.temporal.io/cli/setup-cli),
then from the repository root:

```sh
bun ci
bun run build
bunx tsc -p examples/temporal/tsconfig.build.json
temporal server start-dev --db-filename .context/temporal-dev.db   # separate terminal
node .context/temporal/worker.js                                   # separate terminal
node .context/temporal/client.js
```

The Client prints the Workflow ID and a result with `rows: ["alpha", "beta"]`,
`count: 2`, a Tubeless `runId`, and `preview: false`. Inspect
`tubeless-normalize-demo` in the Web UI at `http://localhost:8233`; Tubeless
step logs and trace events are in the Worker's output.

The Client uses a stable Workflow ID with `REJECT_DUPLICATE`, so rerunning it
fails while that execution is retained. Set `TEMPORAL_WORKFLOW_ID` for an
intentional new one. `TEMPORAL_ADDRESS` and `TEMPORAL_NAMESPACE` default to
`localhost:7233` and `default`. For Temporal Cloud, configure TLS and
authentication on both `Connection` and `NativeConnection`
([connection requirements](https://docs.temporal.io/develop/typescript/temporal-client))
and keep credentials in host configuration, not Workflow inputs.

## How Tubeless maps to Temporal

- **Validation:** `runPipeline` validates the job first; invalid input raises a
  non-retryable `ApplicationFailure` because another attempt cannot fix it.
- **Identity:** the correlation ID combines namespace, Workflow ID, Workflow run
  ID, and Activity ID and is stable across Activity retries. Each attempt gets a
  fresh Tubeless `runId`. Pass `job.parentRunId` only for a known Tubeless
  execution, never a Temporal run ID.
- **Heartbeats:** progress hooks heartbeat with step ID and counts, and a
  five-second timer covers quiet steps. These report progress only; they are not
  checkpoints.
- **Logs:** pipeline logs and trace events go through the Activity logger.
  Temporal history records the Activity boundary, not each Tubeless step. To view
  remote step histories in Studio, compose the trace exporter with a destination
  that keeps raw events (Worker log wrappers are not importable NDJSON), and
  apply your redaction policy there.

## Retries, cancellation, and gotchas

- **Retries:** the Workflow sets a one-minute limit per attempt, a five-minute
  overall limit, a 15-second heartbeat timeout, and three attempts. An Activity
  retry reruns the entire pipeline; Temporal does not checkpoint individual
  Tubeless steps. Add business-level idempotency keys before adding writes, and
  expect overlapping attempts after timeouts. For independently retryable
  phases, use separate Activities, each hosting a smaller pipeline
  ([timeouts and retries](https://docs.temporal.io/develop/typescript/failure-detection)).
- **Cancellation:** the Activity passes `Context.current().cancellationSignal`
  to Tubeless, and steps must forward `context.signal` into waits and I/O. The
  adapter restores Temporal's cancellation failure via `activity.cancelled` so
  cancellation is not retried as an ordinary failure. The Workflow uses
  `WAIT_CANCELLATION_COMPLETED`. Cancel with
  `temporal workflow cancel --workflow-id tubeless-normalize-demo`.
  Cancellation is cooperative, not rollback, and closing the Client does not
  cancel the Workflow.
- **Dry runs:** `dryRun: true` in the job still creates a real Workflow and
  Activity. Mark writes `dryRun: "skip"` or provide a preview handler. To
  preview without Temporal, run the local registration, which executes locally:

```sh
bun run tubeless -- plan --project examples/project/tubeless.project.ts temporal-normalize
bun run tubeless -- run --project examples/project/tubeless.project.ts temporal-normalize -- \
  --lines " Alpha " --lines "Beta" --dry-run
```

`make check` runs the Activity in `MockActivityEnvironment` and bundles the
Workflow with Temporal's bundler; it needs no service. Test connectivity,
authentication, worker shutdown, and idempotency in your own deployment.
