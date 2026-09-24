# Choosing an execution approach

Tubeless runs typed, dependency-ordered work inside a Node.js process. That work
might be a data pipeline, a multi-step application workflow, or an AI workload.
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

## Nearby tools

These tools differ in where they run work and how they handle persistence.
Tubeless runs inside your TypeScript application, with an optional CLI and local
Studio for running commands and inspecting results.

| Tool                                                                                                       | Use it for                                     | Next to Tubeless                                                                                        |
| ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| [Apache Hamilton](https://hamilton.apache.org/)                                                            | Typed Python dataflows from ordinary functions | Closest analog. Tubeless does that job in TypeScript, with `plan()`, dry-run, a CLI, and a local studio |
| [listr2](https://listr2.kilic.dev/)                                                                        | Terminal task lists with live progress         | Use listr2 when shared context is enough. Use Tubeless when steps pass typed results and need a plan    |
| [Prefect](https://www.prefect.io/), [Dagster](https://dagster.io/), [Airflow](https://airflow.apache.org/) | Scheduled data-platform work and shared UI     | Run a Tubeless pipeline inside one task, asset, or flow                                                 |
| [Temporal](https://temporal.io/), [Inngest](https://www.inngest.com/), [Trigger.dev](https://trigger.dev/) | Crash-resume and long-lived app workflows      | Run a Tubeless pipeline inside one activity or durable step                                             |
| [LangGraph](https://www.langchain.com/langgraph)                                                           | Dynamic LLM agent loops                        | Use LangGraph for the agent. Use Tubeless for typed retrieval, validation, and publication around it    |

## Integrating with those tools

Tubeless does not replace a scheduler, queue, or durable engine. Pair it with
one of those tools in either of two ways:

| Need                                                       | Approach                                                     | Example                                                 |
| ---------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------- |
| The host should own delivery, retries, and crash resume    | Call `pipeline.runOrThrow` from a worker or activity handler | [`host-embedding.ts`](../examples/host-embedding.ts)    |
| One step of a local pipeline should run on another service | Use `fromRemote` for that step                               | [Remote-step composition](./remote-step-composition.md) |

The host owns persistence and acknowledgement. A rejected run tells it that
processing failed. The parent Tubeless process does not restore itself after
exit; if that is required, the host must provide it.

The [Tubeless ↔ Airflow guide](./airflow.md) connects both patterns in one example:
submit a DAG through `fromRemote`, run a Tubeless pipeline inside its task, and
validate the returned XCom before continuing locally.

The [Temporal guide](./temporal.md) hosts a pipeline inside an Activity and keeps
its execution outside replayed Workflow code, with Activity-owned retries,
heartbeats, and cancellation.

The [Dagster guide](./dagster.md) materializes an asset through Dagster Pipes,
with progress logs, content data versions, and a trace for Tubeless Studio.
Dagster owns retries of the asset; Tubeless owns execution of its internal steps.

The [Step Functions guide](./step-functions.md) invokes a pipeline inside a Lambda
Task and includes a SAM deployment. Step Functions owns workflow recovery;
Tubeless supplies typed steps and progress within each Lambda invocation.
