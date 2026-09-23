# Tubeless ↔ Airflow

Keep Airflow in charge of scheduling and task delivery while Tubeless handles
typed work inside a task. Or let a Tubeless pipeline call an existing Airflow
DAG through `fromRemote` and use its result in later steps.

The examples connect both directions: a local Tubeless pipeline submits an
Airflow DAG, the DAG runs another Tubeless pipeline, and the caller validates
the result returned through XCom. They use Airflow 3's public `/api/v2` API and
`airflow.sdk`. Airflow 2 requires a different adapter and DAG imports.

## Choose who owns execution

| Direction          | Example                                                                                                        | Execution owner                                                     |
| ------------------ | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Tubeless → Airflow | [`remote.ts`](../examples/airflow/remote.ts)                                                                   | Airflow owns the submitted DAG; the local process waits for it      |
| Airflow → Tubeless | [`tubeless_example.py`](../examples/airflow/tubeless_example.py), [`hosted.ts`](../examples/airflow/hosted.ts) | Airflow owns delivery and retries of the entire Tubeless invocation |

These are application examples, not a built-in Airflow provider. They use public
Tubeless imports and native `fetch`; the core runtime gains no dependencies.
Use either direction independently. The Python DAG can also be triggered
directly from Airflow with `{"lines": [" Alpha ", "Beta"]}` as its run configuration.

## Run the examples together

### Prepare the Tubeless project

From a checkout of this repository:

```sh
bun ci
bun run build
```

The Airflow execution workers need Bun 1.3.14 or later and this built project.
Set `TUBELESS_EXAMPLE_ROOT` to its absolute path in the worker environment.
For a local Airflow installation sharing the checkout:

```sh
export TUBELESS_EXAMPLE_ROOT="$(pwd)"
```

For distributed workers, install the project and its dependencies in every
worker image, or adapt the task to your container operator. A path on the
machine running the Airflow UI is insufficient. The Python task uses an
argument list with `subprocess.run`, passes JSON on stdin, and keeps the
executable path in deployment configuration.

### Register the Airflow DAG

Use an existing Airflow 3 installation or follow the official
[local quick start](https://airflow.apache.org/docs/apache-airflow/stable/start.html).
Copy [`tubeless_example.py`](../examples/airflow/tubeless_example.py) into its
configured DAGs folder. Start the scheduler and workers with the environment
above, verify that `tubeless_example` imports successfully, and unpause it.
The DAG has no schedule and runs only when triggered.

Obtain a JWT through your deployment's configured auth manager and place it in
`AIRFLOW_TOKEN` in the **calling** process. See Airflow's
[public API authentication](https://airflow.apache.org/docs/apache-airflow/stable/security/api.html).
Grant access to trigger this DAG, read its runs, and read the task's XComs.
The example reads the token only during execution; importing and planning need
no credentials. Use HTTPS outside local development.

### Preview and run from Tubeless

From the repository root, inspect the graph without contacting Airflow:

```sh
bun run tubeless -- plan examples/airflow/remote.ts
```

Run with a stable ID for this business request:

```sh
bun run tubeless -- run --trace .tubeless/airflow.ndjson \
  examples/airflow/remote.ts -- \
  --api-url http://localhost:8080/api/v2/ \
  --request-id normalize-demo-001 \
  --source examples/rows.txt
```

The API base includes `/api/v2/`; a deployment prefix such as
`https://example.com/airflow/api/v2/` is preserved. The default total wait is
120 seconds; use `--timeout-ms 600000` if the queue and task retries take longer.
Add `--dry-run` after `--` to skip submission and downstream consumption without
making any HTTP requests. The command is also registered as `airflow-remote`
in the [project with custom adapters](../examples/project/tubeless.project.ts).

Inspect the local recording afterward:

```sh
bun run tubeless -- history --trace .tubeless/airflow.ndjson
bun run tubeless -- ui --trace .tubeless/airflow.ndjson
```

## Tubeless → Airflow: submit, wait, validate

The `normalize-in-airflow` step maps domain inputs into DAG `conf`, including
the caller's Tubeless `runId`. Its adapter:

1. Derives a deterministic `dag_run_id` from the supplied request ID and submits
   `POST /dags/tubeless_example/dagRuns` with `logical_date: null`.
2. Reads the run back and verifies its identity and business inputs. An HTTP 409
   attaches to that same run only when the inputs match.
3. Polls `queued` and `running` states and reports progress. A failed DAG or
   unknown state fails the local step.
4. Reads the `normalize` task's `return_value` XCom after DAG success. The
   `outputSchema` validates rows, count, Tubeless run ID, and preview flag before
   `summarize` can consume them.

The result is a small native JSON object using the default XCom backend. Custom
XCom backends may return storage references and need their own result retrieval.
For large datasets, return a small artifact reference and validate the fetched
artifact at the consumer boundary. See the
[Airflow 3 REST API](https://airflow.apache.org/docs/apache-airflow/3.1.6/stable-rest-api-ref.html)
and [XCom guidance](https://airflow.apache.org/docs/apache-airflow/stable/core-concepts/xcoms.html).

Reusing the same request ID and inputs reattaches to the existing run, including
a completed or failed run. It never clears tasks or silently reruns failures.
If a submission response is lost, rerun the caller with the same ID to discover
the original run. Retain Airflow run records for this deduplication window.
Use a new ID only when another execution is intentional; external writes still
need business-level idempotency.

The adapter does not retry HTTP failures automatically. HTTP errors retain a
machine-readable status code without copying response bodies or credentials
into diagnostics. Token refresh belongs to the application.

## Airflow → Tubeless: one task, one invocation

The Python task supplies Airflow identities and `dag_run.conf` to
[`worker.ts`](../examples/airflow/worker.ts). The worker validates the envelope
and calls `AirflowHostedPipeline.runOrThrow`. Normalization is pure and safe to
repeat; adapt it into meaningful steps for your application.

Airflow owns two task retries, each of which starts a new Tubeless execution.
The worker writes its result to a private temporary file only after successful
completion. Python returns that JSON as the task's `return_value` XCom. A
pipeline failure, nonzero subprocess exit, or 90-second subprocess timeout
raises in Python, so Airflow can apply its retry policy.

The worker emits Tubeless NDJSON trace events to stdout, which goes to the
Airflow task log. The Python task logs its attempt number. Run correlation uses
the Airflow DAG, run, task, and map index and stays stable across retries;
Tubeless assigns a fresh `runId` for every attempt. A Tubeless `parentRunId` is
set only when the caller supplied an actual Tubeless execution identity.
Standalone Airflow launches have no Tubeless parent.

The Airflow task log may wrap each event with its own formatting. It is not
automatically an importable Tubeless NDJSON artifact. To collect remote runs in
Studio, supply a trace exporter that stores the raw events durably. The local
caller's trace records one remote step and the returned child run ID; it does
not reconstruct the child's step history. Logs and traces may contain domain
data, so apply your application's redaction policy before exporting them.

## Recovery boundaries

Cancelling or timing out the local caller aborts its HTTP requests and polling.
The Airflow job may continue. The example deliberately sends no remote cancel,
clear, or state-changing recovery request. A successful HTTP abort does not
establish that remote work stopped.

The local parent is not restored after process exit. A fresh execution can
reattach to the Airflow run through the same request ID, but this reruns the
local pipeline rather than resuming a checkpoint. The remote child remains
linked to the original parent's execution identity.

Choose task boundaries that can be retried together. Replaying an Airflow task
repeats the entire hosted pipeline, including completed steps. Use idempotent
writes or application-owned checkpoints before introducing side effects. For
hosted dry runs, propagate `conf.dry_run` and mark writes with `dryRun: "skip"`
or provide side-effect-free preview handlers.

This on-demand example supplies no data interval. Scheduled and backfill jobs
should pass Airflow's data interval explicitly as domain input and preserve its
meaning when moving execution between hosts. See
[DAG run intervals](https://airflow.apache.org/docs/apache-airflow/stable/core-concepts/dag-run.html#data-interval).

## Verification

The package checks compile the TypeScript examples and exercise submission,
reattachment, conflicting inputs, progress, invalid XComs, HTTP failures, dry
runs, cancellation, and timeouts against a local HTTP fixture. They also run
the real Bun worker and check success-only result publication. These checks do
not substitute for testing the DAG in your Airflow deployment with its auth
manager, executor, and XCom backend.
