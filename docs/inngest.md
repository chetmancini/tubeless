# Tubeless on Inngest

Run a Tubeless pipeline inside an Inngest `step.run`. Inngest owns event delivery,
retries, and durable step results; Tubeless owns the typed graph, progress, and
execution report within each attempt.

```text
Event sender → Inngest function → step.run → Tubeless pipeline
```

Keep the pipeline invocation inside the durable step callback. Inngest may
execute the function handler several times as it restores saved step results.
Code outside steps can execute again. See
[how Inngest functions execute](https://www.inngest.com/docs/learn/how-functions-are-executed).

## The example

| File                                               | Responsibility                                                                  |
| -------------------------------------------------- | ------------------------------------------------------------------------------- |
| [`pipeline.ts`](../examples/inngest/pipeline.ts)   | Normalize and deduplicate rows using public Tubeless imports                    |
| [`functions.ts`](../examples/inngest/functions.ts) | Validate event data and run the pipeline in a durable step with correlated logs |
| [`client.ts`](../examples/inngest/client.ts)       | Configure the shared Inngest client                                             |
| [`server.ts`](../examples/inngest/server.ts)       | Serve the function at `/api/inngest` using Node's HTTP server                   |
| [`send.ts`](../examples/inngest/send.ts)           | Send a sample event and print its accepted event IDs                            |

The pipeline has no Inngest imports and also runs locally. The example uses
Inngest TypeScript SDK 4.21.0 and `@inngest/test` 1.0.0, installed as development
dependencies here. Consumer applications install `inngest` themselves. Tubeless
keeps its dependency-free runtime and adds no Inngest public API.

SDK v4 puts `triggers` in the `createFunction` options. Older v3 examples use a
separate trigger argument; see the
[v4 migration guide](https://www.inngest.com/docs/reference/typescript/v4/migrations/v3-to-v4).

## Run locally

Use Node.js 22.6 or later and Bun 1.3.14 or later. From the repository root:

```sh
bun ci
bun run build
bunx tsc -p examples/inngest/tsconfig.build.json
INNGEST_DEV=1 node .context/inngest/server.js
```

The compiler writes JavaScript to `.context/inngest/`. The server listens on
`127.0.0.1:3000`. In a second terminal, start the
[Inngest Dev Server](https://www.inngest.com/docs/local-development):

```sh
npx inngest-cli@latest dev -u http://127.0.0.1:3000/api/inngest
```

Open `http://localhost:8288` and confirm that `tubeless-example` has synced and
lists `normalize-rows`. In a third terminal, send the sample event:

```sh
INNGEST_DEV=1 node .context/inngest/send.js
```

The sender prints accepted event IDs. It does not wait for the pipeline result.
Open the resulting run in the Dev Server UI: `run-pipeline` returns
`rows: ["alpha", "beta"]`, `count: 2`, a Tubeless `runId`, and `preview: false`.
Sending again creates another event and function run. This example does not
deduplicate separate submissions.

`INNGEST_DEV=1` selects local development for both server and sender. For a
deployment, host the endpoint where Inngest can reach it, remove that setting,
configure `INNGEST_SIGNING_KEY` and `INNGEST_EVENT_KEY` through your host's secret
configuration, and sync the app. The loopback example is for local development.
See [serving functions](https://www.inngest.com/docs/reference/typescript/serve)
and [client configuration](https://www.inngest.com/docs/reference/typescript/client/create).

## Validation, results, and observation

The function validates `event.data` before calling `runOrThrow`. Invalid rows or
control metadata throw Inngest's `NonRetriableError` directly. A TypeScript type
on the sender cannot validate incoming events. Keep this validation outside the
Tubeless invocation so its execution-error wrapper cannot hide the host's
non-retryable error type. See
[Inngest errors](https://www.inngest.com/docs/reference/typescript/errors).

The correlation ID combines the Inngest run ID and durable step ID. It stays
stable across retries of that step. Each pipeline attempt gets a fresh Tubeless
`runId`. Only pass `parentRunId` when it identifies a known Tubeless execution;
an Inngest run ID belongs in correlation metadata.

The pipeline returns plain JSON data. Inngest serializes step results, so avoid
returning contexts, errors, signals, class instances, or a whole execution report.
Large datasets should live in external storage with a small reference returned
from the step. See [step result serialization](https://www.inngest.com/docs/reference/typescript/functions/step-run).

Pipeline logs, progress hooks, and trace events go through the function logger.
The Inngest UI records one durable step for the pipeline. To inspect individual
Tubeless steps in Studio, retain raw trace events using an application-owned
exporter. Logger envelopes are not importable Tubeless NDJSON traces. Apply
redaction before retaining or forwarding events.

## Retries and durable boundaries

The function sets `retries: 2`: up to three attempts for the durable step.
`runOrThrow` lets execution failures reach Inngest. A failed attempt reruns the
entire pipeline, including any successful internal steps. Once Inngest saves
the durable step's successful result, subsequent handler executions reuse that
result, including the original Tubeless `runId`, without invoking the pipeline.

Normalization and deduplication are safe to repeat. If you add writes, use
business-level idempotency keys: a process can fail after a write but before its
result is saved. Correlation IDs do not deduplicate side effects. See
[Inngest steps](https://www.inngest.com/docs/learn/inngest-steps).

For independently retryable phases, define multiple Inngest steps at the
function level, each calling a smaller Tubeless pipeline and passing JSON
results to the next phase. Do not call Inngest step tools from inside Tubeless
handlers or hooks nested in `step.run`. Place durable sleeps and event waits
between these phases. Tubeless `context.sleep` is an ordinary process-local
wait, and internal progress is not a durable checkpoint.

## Cancellation and dry runs

Inngest cancellation prevents subsequent steps from running; it does not stop
an already executing step. This adapter therefore does not supply a host
cancellation signal. Cancelling a run in the dashboard can leave its active
Tubeless pipeline running to completion. Closing the sender does not cancel
the function. See [Inngest cancellation](https://www.inngest.com/docs/features/inngest-functions/cancellation).

The pipeline cooperates with signals supplied by local callers. Applications
that need an execution deadline can supply their own signal and forward it to
I/O, but a local abort is separate from Inngest cancellation. Keep work within
the execution limits of your deployment and make side effects safe to retry.

Set `dryRun: true` in the sender's job to forward Tubeless dry-run controls.
This still sends a real event and runs an Inngest function. The example performs
only pure transformations. Mark any added writes with `dryRun: "skip"` or a
side-effect-free preview handler.

To plan or preview without contacting Inngest, use the project registration:

```sh
bun run tubeless -- plan --project examples/project/tubeless.project.ts inngest-normalize
bun run tubeless -- run --project examples/project/tubeless.project.ts inngest-normalize -- \
  --lines " Alpha " --lines "Beta" --dry-run
```

## Verification

`make check` compiles the examples against the real SDK and uses
[`InngestTestEngine`](https://www.inngest.com/docs/reference/typescript/v4/testing)
to exercise the durable step with the real Tubeless pipeline. Tests cover JSON
results, progress and traces, invalid input, dry runs, supplied saved step state,
and a failed execution followed by a fresh attempt with stable correlation.
These tests need no service or credentials and do not test server-side retry
scheduling. Use the local server flow above to verify event delivery and inspect
the run; test deployment authentication and side-effect idempotency separately.
