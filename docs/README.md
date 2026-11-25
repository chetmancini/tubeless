# Tubeless documentation

Start with the [package README](../README.md) and [getting started](./getting-started.md),
then use the [recipe index](./recipes.md) to find an example to adapt.
Guides for developers and coding agents are also on the [website](https://tubeless.io/).

| Document                                                | Use it for                                                         |
| ------------------------------------------------------- | ------------------------------------------------------------------ |
| [Getting started](./getting-started.md)                 | Building, running, and testing a first pipeline                    |
| [Recipe index](./recipes.md)                            | Finding a working example for your task                            |
| [Core concepts](./concepts.md)                          | Dependencies, skips, failures, dry runs, and contexts              |
| [CLI](./cli.md)                                         | `list`, `inspect`, `plan`, `graph`, `run`, `history`, exit codes   |
| [GitHub Action](./github-action.md)                     | Plan a pipeline in Actions and post the Mermaid graph              |
| [Reproduction manifests](./reproduction-manifest.md)    | Rerunning an eligible Cloud Node check at its original revision    |
| [Studio](./studio.md)                                   | Run history, project commands, and gateway hosting                 |
| [Artifacts](./artifacts.md)                             | Typed loaders, savers, and recorded lineage                        |
| [Step output observation](./step-output-observation.md) | Capturing and supplying raw outputs through host-owned persistence |
| [Step output recovery](./step-output-recovery.md)       | Restoring compatible raw values across host process restarts       |
| [YAML and JSON pipelines](./declarative-pipelines.md)   | Compiling documents with registered handlers                       |
| [In-process agents](./agents.md)                        | Model-backed agents, tools, subagents, and durable execution       |
| [Child pipelines](./child-pipeline-composition.md)      | Running a reusable pipeline once or per item                       |
| [Remote steps](./remote-step-composition.md)            | Calling remote services and worker threads                         |
| [Deploy to Cloudflare](./deploy-cloudflare.md)          | Hosting Studio and pipelines behind Access                         |
| [Execution journals](./execution-journal.md)            | Recovering acknowledged work with host-owned storage and fencing   |
| [Comparison](./comparison.md)                           | How Tubeless fits next to other job runners                        |

To host pipelines in an existing engine, see [Airflow](./airflow.md),
[Temporal](./temporal.md), [Inngest](./inngest.md), [Dagster](./dagster.md), or
[Step Functions](./step-functions.md).

For coding agents: the [agent guide](./agent-guide.md), the
[skill pack](./agent-skills.md), and the [LLM index](./llms.txt). For exports,
use the [generated API inventory](./api-reference.md) and
[machine-readable report](./api-report.json).
