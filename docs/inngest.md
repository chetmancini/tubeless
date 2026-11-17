# Tubeless on Inngest

Run a Tubeless pipeline inside an Inngest `step.run`. Inngest owns event
delivery, retries, and durable step results; Tubeless owns the typed graph,
progress, and execution report within each attempt.

```text
Event sender → Inngest function → step.run → Tubeless pipeline
```

Invoke the pipeline inside the durable step callback. Inngest may execute the
function handler several times to restore saved step results, so code outside
steps can run again
([how functions execute](https://www.inngest.com/docs/learn/how-functions-are-executed)).

## The example

| File                                               | Responsibility                                             |
| -------------------------------------------------- | ---------------------------------------------------------- |
| [`pipeline.ts`](../examples/inngest/pipeline.ts)   | The pipeline, with no Inngest imports                      |
| [`functions.ts`](../examples/inngest/functions.ts) | Validate event data and run the pipeline in a durable step |
| [`client.ts`](../examples/inngest/client.ts)       | Shared Inngest client                                      |
| [`server.ts`](../examples/inngest/server.ts)       | Serve the function at `/api/inngest` on `127.0.0.1:3000`   |
| [`send.ts`](../examples/inngest/send.ts)           | Send a sample event and print the accepted event IDs       |

It uses Inngest TypeScript SDK 4.21.0, which puts `triggers` in the
`createFunction` options (v3 used a separate argument;
[migration guide](https://www.inngest.com/docs/reference/typescript/v4/migrations/v3-to-v4)).
Your application installs `inngest` itself.

## Setup

Use Node.js 22.18 or later and Bun 1.3.14 or later. From the repository root:

```sh
bun ci
bun run build
bunx tsc -p examples/inngest/tsconfig.build.json
INNGEST_DEV=1 node .context/inngest/server.js
```

In a second terminal, start the
[Inngest Dev Server](https://www.inngest.com/docs/local-development), open
`http://localhost:8288`, and confirm `tubeless-example` synced with
`normalize-rows`:

```sh
npx inngest-cli@latest dev -u http://127.0.0.1:3000/api/inngest
```

In a third, send the event, then open the run in the Dev Server UI. It does not
wait for the result; `run-pipeline` returns `rows: ["alpha", "beta"]`,
`count: 2`, a Tubeless `runId`, and `preview: false`. Sending again creates
another run; the example does not deduplicate submissions.

```sh
INNGEST_DEV=1 node .context/inngest/send.js
```

**Deploying:** host the endpoint where Inngest can reach it, remove
`INNGEST_DEV`, set `INNGEST_SIGNING_KEY` and `INNGEST_EVENT_KEY` from your
secret configuration, and sync the app. `server.ts` always binds to loopback,
so either reverse-proxy your public HTTPS `/api/inngest` to it (preserving
method, body, and headers) or register `normalizeFunction` with your framework's
Inngest adapter instead
([serving functions](https://www.inngest.com/docs/reference/typescript/serve)).

## How Tubeless maps to Inngest

- **Validation:** the function validates `event.data` before `runOrThrow`
  (sender types cannot validate incoming events). Invalid input throws
  `NonRetriableError` outside the Tubeless call, so Tubeless's execution-error
  wrapper cannot hide it ([errors](https://www.inngest.com/docs/reference/typescript/errors)).
- **Identity:** correlation combines the Inngest run ID and durable step ID and is
  stable across retries of that step; each attempt gets a fresh Tubeless
  `runId`. Pass `parentRunId` only for a known Tubeless execution.
- **Results:** return plain JSON. Do not return contexts, errors, signals, class
  instances, or whole execution reports; keep large datasets in external storage
  and return a reference
  ([step results](https://www.inngest.com/docs/reference/typescript/functions/step-run)).
- **Observation:** logs, progress, and traces go through the function logger,
  and Inngest shows one durable step. For per-step history in Studio, keep raw
  trace events with your own exporter (logger envelopes are not importable
  NDJSON) and redact first.

## Retries, cancellation, and gotchas

- **Retries:** `retries: 2` gives three attempts. A failed attempt reruns the
  whole pipeline. After Inngest saves the step result, later handler executions
  reuse it, including the original `runId`, without running the pipeline. A
  process can fail after a write but before the result is saved, so added writes
  need business-level idempotency keys; correlation IDs do not deduplicate
  side effects.
- **Durable phases:** for independently retryable phases, use several Inngest
  steps, each calling a smaller pipeline and passing JSON onward. Never call
  Inngest step tools inside Tubeless handlers or hooks nested in `step.run`.
  Put durable sleeps and event waits between phases; `context.sleep` is a
  process-local wait.
- **Cancellation:** Inngest cancellation prevents later steps but does not stop a
  running one, so the adapter supplies no host signal and a cancelled run's
  pipeline can finish. You may pass your own deadline signal, but that is
  separate from Inngest cancellation
  ([cancellation](https://www.inngest.com/docs/features/inngest-functions/cancellation)).
- **Dry runs:** `dryRun: true` in the sender's job still sends a real event.
  Mark writes `dryRun: "skip"` or provide a preview handler. To preview without
  Inngest:

```sh
bun run tubeless -- plan --project examples/project/tubeless.project.ts inngest-normalize
bun run tubeless -- run --project examples/project/tubeless.project.ts inngest-normalize -- \
  --lines " Alpha " --lines "Beta" --dry-run
```

`make check` uses [`InngestTestEngine`](https://www.inngest.com/docs/reference/typescript/v4/testing)
with the real pipeline. It does not test server-side persistence or retry
scheduling; use the local flow above for delivery, and test authentication and
idempotency in your deployment.
