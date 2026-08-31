# Comparison

Tubeless is an in-process typed DAG you import from TypeScript or run from a
Bun CLI. It is not a hosted workflow engine, a job queue, or a warehouse
scheduler.

## Same job: local typed steps

These all run work in one process. The difference is how much graph, typing,
and preview you get without writing it yourself.

| Feature                                 | tubeless                   | roll your own   | p-graph | listr2                |
| --------------------------------------- | -------------------------- | --------------- | ------- | --------------------- |
| Typed step outputs through dependencies | Yes                        | If you write it | No      | Weak (shared context) |
| Invalid graphs rejected at definition   | Yes                        | No              | Partial | No                    |
| Plan / preview without executing        | Yes                        | No              | No      | No                    |
| Dry-run and write gates                 | Yes                        | If you write it | No      | No                    |
| Declared targets and partial rerun      | Yes                        | If you write it | No      | No                    |
| Child pipelines and fan-out             | Yes                        | If you write it | No      | Nested tasks          |
| Inspect / plan / graph / run CLI        | Yes (Bun)                  | No              | No      | TTY task renderer     |
| Local run history                       | Optional SQLite            | No              | No      | No                    |
| Crash-resume the graph                  | No (file checkpoints only) | If you write it | No      | No                    |

Roll your own `await` / `Promise.all` is enough for two or three linear steps
with no dry-run, no partial rerun, and no typed fan-out. p-graph is topo-order
plus concurrency. listr2 is a terminal task list (pretty TTY, rollback), not a
reusable typed data graph.

File checkpoints (`openCheckpoint` in `tubeless/node`) record an "already
done" set for batch API work. They do not replay a crashed process the way a
durable workflow engine does.

## Different job

| If you need…                                          | Use                                     |
| ----------------------------------------------------- | --------------------------------------- |
| Typed local DAG, plan, dry-run, write gates           | tubeless                                |
| Two or three `await`s and failure is "throw and exit" | roll your own                           |
| Pretty CLI spinners, not a typed data graph           | listr2                                  |
| Survive process death, sleep for days, wait on humans | Temporal, Inngest, Trigger.dev, or DBOS |
| Thousands of the same job with retries across workers | BullMQ, pg-boss, or graphile-worker     |
| Org-wide schedule, catalog, warehouse assets          | Airflow, Dagster, or dbt                |
| Record-at-a-time streams                              | Node streams or RxJS                    |

Those last four can still _call_ a tubeless pipeline. A queue worker or a
durable step can run `pipeline.runOrThrow(...)` when the hard part inside the
job is a gated, typed graph.

| Need                                                                  | Composition                                                                                                                              | Who drives the DAG   | Who survives process death                        |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | ------------------------------------------------- |
| The graph must outlive the process, sleep for days, or wait on humans | Host embedding: a Temporal workflow, Lambda handler, or queue worker calls `pipeline.runOrThrow(...)` and passes `runId` / `parentRunId` | The engine           | The engine                                        |
| Some steps run elsewhere; the rest stay local                         | `fromRemote`: one opaque parent step per remote unit of work                                                                             | The tubeless process | Only the remote job, not the parent `PipelineRun` |

## When tubeless is the wrong default

- The pipeline must outlive the process. Use a durable engine as the
  orchestrator.
- The unit of work is one item, tens of thousands of times. Queue the items.
- The consumer is a data platform, not a TypeScript repo. Use the platform.
- You need a stable 1.x API or Windows. This package is `0.1.0`, and Windows
  is untested. The CLI runs through Bun; `npx tubeless` works wherever Bun is
  installed and otherwise prints Bun install instructions.
