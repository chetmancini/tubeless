# Tubeless ↔ Airflow

Keep Airflow in charge of scheduling and task delivery while Tubeless handles
typed work inside a task, or let a Tubeless pipeline call an existing Airflow
DAG through `fromRemote` and use its result in later steps. The two directions
work independently.

The examples use Airflow 3's public `/api/v2` API and `airflow.sdk` (Airflow 2
needs a different adapter and DAG imports). They are application examples, not
a built-in provider.

| Direction          | Example                                                                                                        | Who owns execution                                                 |
| ------------------ | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Tubeless → Airflow | [`remote.ts`](../examples/airflow/remote.ts)                                                                   | Airflow runs the submitted DAG; the local process waits            |
| Airflow → Tubeless | [`tubeless_example.py`](../examples/airflow/tubeless_example.py), [`hosted.ts`](../examples/airflow/hosted.ts) | Airflow owns delivery and retries of the whole Tubeless invocation |

## Setup

1. From a checkout, run `bun ci && bun run build`. Airflow workers need Bun
   1.3.14 or later and this built project; set `TUBELESS_EXAMPLE_ROOT` to its
   absolute path in the worker environment. For distributed workers, install the
   project in every worker image (a path on the UI machine is not enough).
2. Copy [`tubeless_example.py`](../examples/airflow/tubeless_example.py) into
   your Airflow 3 DAGs folder, confirm `tubeless_example` imports, and unpause
   it. It has no schedule. To trigger it directly, use the run configuration
   `{"lines": [" Alpha ", "Beta"]}`.
3. Obtain a JWT from your auth manager and set `AIRFLOW_TOKEN` in the
   **calling** process
   ([API authentication](https://airflow.apache.org/docs/apache-airflow/stable/security/api.html)).
   It needs permission to trigger the DAG, read its runs, and read the task's
   XComs. Planning needs no credentials; use HTTPS outside local development.
4. Preview, then run, from the repository root:

```sh
bun run tubeless -- plan examples/airflow/remote.ts
bun run tubeless -- run --trace .tubeless/airflow.ndjson \
  examples/airflow/remote.ts -- \
  --api-url http://localhost:8080/api/v2/ \
  --request-id normalize-demo-001 \
  --source examples/rows.txt
```

The API base must include `/api/v2/`; a deployment prefix is preserved. The
total wait defaults to 120 seconds (`--timeout-ms` changes it). `--dry-run`
after `--` makes no HTTP requests. Inspect the recording with
`bun run tubeless -- history --trace .tubeless/airflow.ndjson` or `ui`.

## Tubeless → Airflow

The `normalize-in-airflow` step submits `POST /dags/tubeless_example/dagRuns`
with a `dag_run_id` derived from `--request-id`, polls until the DAG finishes,
then reads the `normalize` task's `return_value` XCom and validates it with
`outputSchema` before `summarize` sees it.

- **Idempotency:** the same request ID and inputs reattach to the existing run
  (including a completed or failed one) and never clear or rerun tasks. Use a
  new ID only for an intentional new execution. Keep Airflow run records for
  as long as you need this deduplication. External writes still need
  business-level idempotency.
- **Results:** the example returns a small JSON object over the default XCom
  backend. Custom XCom backends may return storage references; for large data
  return an artifact reference and validate the fetched artifact.
- **Failures:** HTTP failures are not retried by the adapter and keep a status
  code without response bodies or credentials. Token refresh is the
  application's job.

## Airflow → Tubeless

The Python task passes Airflow identities and `dag_run.conf` to
[`worker.ts`](../examples/airflow/worker.ts), which validates the envelope and
calls `AirflowHostedPipeline.runOrThrow`. The result is written to a temporary
file only on success and returned as the task's `return_value` XCom.

- Airflow owns two task retries; each starts a new Tubeless execution with a
  fresh `runId`. A pipeline failure, nonzero exit, or the 90-second subprocess
  timeout raises in Python so Airflow applies its retry policy.
- Correlation uses the DAG, run, task, and map index and is stable across
  retries. `parentRunId` is set only for a real Tubeless execution identity.
- Trace events go to stdout, so into the task log. Airflow's log formatting
  makes that unimportable as Tubeless NDJSON; to view remote runs in Studio,
  supply a trace exporter that stores raw events. The caller's own trace shows
  one remote step and the child run ID, not the child's steps. Redact domain
  data before exporting.

## Behaviour mapping and gotchas

| Concern      | Behaviour                                                                                                                                                                                                          |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Retries      | An Airflow task retry repeats the entire hosted pipeline, including completed steps. Use idempotent writes or your own checkpoints.                                                                                |
| Cancellation | Aborting or timing out the local caller stops its polling only. The Airflow run may continue; the example sends no remote cancel.                                                                                  |
| Recovery     | After caller exit, rerun with the same request ID to reattach. This reruns the local pipeline; it does not resume a checkpoint.                                                                                    |
| Dry runs     | Propagate `conf.dry_run` and mark writes `dryRun: "skip"` or provide a side-effect-free preview.                                                                                                                   |
| Intervals    | The example supplies no data interval. For scheduled or backfill runs pass it explicitly as domain input ([docs](https://airflow.apache.org/docs/apache-airflow/stable/core-concepts/dag-run.html#data-interval)). |

`make check` exercises the adapter against a local HTTP fixture and the real
Bun worker; it does not replace testing the DAG with your auth manager,
executor, and XCom backend.
