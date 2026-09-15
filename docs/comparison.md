# Choosing an execution approach

Tubeless runs typed, dependency-ordered workflows inside a Node.js process.
Use it when you need to pass results between steps, preview execution, control
side effects during dry runs, or inspect step-level failures and progress.

## When ordinary functions are enough

A few sequential function calls may need no pipeline framework. Use `await`
for ordered work and `Promise.all` for independent work when your application
already handles errors, concurrency, and reporting adequately.

Tubeless becomes useful when those calls need shared execution controls:

| Requirement                       | Tubeless support                                                         |
| --------------------------------- | ------------------------------------------------------------------------ |
| Pass typed results between steps  | Dependency output types become input types                               |
| Check dependencies before running | Definitions reject missing dependencies, duplicate IDs, and cycles       |
| Preview work                      | `plan()` shows selection without running step handlers                   |
| Preview side effects              | Each step can skip or substitute a handler during a dry run              |
| Run a specific goal               | Declared targets include required dependencies and failure gates         |
| Reuse a workflow                  | Child pipelines run once or for a list of items                          |
| Inspect execution                 | Run reports, logs, progress, and optional SQLite or NDJSON recording     |
| Use a command line                | The Bun CLI lists, inspects, plans, graphs, and runs registered commands |

See [core concepts](./concepts.md) for control behavior and the
[recipe index](./recipes.md) for implementation examples.

## When you need another kind of system

| Requirement                                                            | What must provide it          |
| ---------------------------------------------------------------------- | ----------------------------- |
| Resume execution after a process crash or wait across process restarts | A durable workflow engine     |
| Distribute many independent jobs across workers                        | A job queue and worker system |
| Schedule and manage shared warehouse or data-platform assets           | A data orchestration platform |
| Process a continuous stream with backpressure                          | A streaming API or framework  |

Tubeless can run inside a worker or activity handler managed by one of these
systems. The host owns delivery, persistence, retries, and acknowledgement;
Tubeless runs the steps inside that invocation.

For example, a queue worker can call `pipeline.runOrThrow(...)` to validate and
process a job. A rejected run tells the worker that processing failed. The
worker decides whether to retry, and the application must make repeated side
effects safe.

## Remote work and checkpoints

Use `fromRemote` when one part of a local pipeline runs on another service.
The parent pipeline still runs in the local process. If that process exits,
a remote job may continue, but Tubeless does not restore the parent run.
See [remote-step composition](./remote-step-composition.md).

File checkpoints from `tubeless/node` can record completed items in batch work
so a later run can skip them. They do not persist or replay the full pipeline.
See [`resumable-enrichment.ts`](../examples/resumable-enrichment.ts).

## Runtime and API stability

Library imports require Node.js 22 or later and use ESM. The CLI requires
Bun 1.3.14 or later. Linux and macOS are supported; Windows is untested.
Tubeless is pre-1.0, so its public API may change. Check the installed version
and release notes when upgrading.
