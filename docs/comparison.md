# Choosing an execution approach

Tubeless runs typed, dependency-ordered work inside a Node.js process. Use it
when steps pass results to each other and you want to preview execution, control
side effects in dry runs, or inspect step-level failures and progress. It is not
a scheduler, queue, or durable engine.

## When ordinary functions are enough

A few sequential calls need no framework: use `await` for ordered work and
`Promise.all` for independent work. Tubeless helps when you need:

| Requirement                       | Tubeless support                                                   |
| --------------------------------- | ------------------------------------------------------------------ |
| Pass typed results between steps  | Dependency output types become input types                         |
| Check dependencies before running | Definitions reject missing dependencies, duplicate IDs, and cycles |
| Preview work and side effects     | `plan()` and per-step dry-run policy                               |
| Run a specific goal               | Targets include required dependencies and failure gates            |
| Reuse a workflow                  | Child pipelines, once or per item                                  |
| Inspect execution                 | Reports, progress, optional SQLite or NDJSON recording             |

See [core concepts](./concepts.md) and the [recipe index](./recipes.md).

## Nearby tools

| Tool                                                                                                       | Use it for                                     | Next to Tubeless                                                       |
| ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------- |
| [Apache Hamilton](https://hamilton.apache.org/)                                                            | Typed Python dataflows from ordinary functions | Closest analog, in TypeScript, with `plan()`, dry-run, CLI, and Studio |
| [listr2](https://listr2.kilic.dev/)                                                                        | Terminal task lists with live progress         | Use Tubeless when steps pass typed results and need a plan             |
| [Prefect](https://www.prefect.io/), [Dagster](https://dagster.io/), [Airflow](https://airflow.apache.org/) | Scheduled data-platform work                   | Run a Tubeless pipeline inside one task, asset, or flow                |
| [Temporal](https://temporal.io/), [Inngest](https://www.inngest.com/), [Trigger.dev](https://trigger.dev/) | Crash-resume and long-lived workflows          | Run a Tubeless pipeline inside one activity or durable step            |
| [LangGraph](https://www.langchain.com/langgraph)                                                           | Dynamic LLM agent loops                        | LangGraph for the agent, Tubeless for typed steps around it            |

## Pairing with a host engine

| Need                                                       | Approach                                             | Example                                                 |
| ---------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------- |
| The host owns delivery, retries, and crash resume          | Call `pipeline.runOrThrow` from a worker or activity | [`host-embedding.ts`](../examples/host-embedding.ts)    |
| One step of a local pipeline should run on another service | Use `fromRemote` for that step                       | [Remote-step composition](./remote-step-composition.md) |

The host owns persistence and acknowledgement, and a rejected run tells it
processing failed. Tubeless does not restore itself after the process exits.
Host guides: [Airflow](./airflow.md), [Temporal](./temporal.md),
[Inngest](./inngest.md), [Dagster](./dagster.md), and
[Step Functions](./step-functions.md).
