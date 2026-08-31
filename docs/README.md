# `tubeless` documentation

## Start here

| Document                                                  | Use it for                                            |
| --------------------------------------------------------- | ----------------------------------------------------- |
| [Website](https://chetmancini.github.io/tubeless/)        | Human docs site and agent entrypoints                 |
| [Package README](../README.md)                            | What it is, a first example, and a pattern table      |
| [Getting started](./getting-started.md)                   | Building, running, and testing a first pipeline       |
| [Recipe index](./recipes.md)                              | Choosing an executable example by intent              |
| [Project catalog](../examples/catalog/tubeless.studio.ts) | File layout, stable IDs, and studio registration      |
| [Core concepts](./concepts.md)                            | Dependencies, skips, failures, dry runs, and contexts |
| [Agent guide](./agent-guide.md)                           | Rules for generating and modifying pipeline code      |
| [Comparison](./comparison.md)                             | When to use tubeless vs other tools                   |

## How to

| Document                    | Use it for                                                   |
| --------------------------- | ------------------------------------------------------------ |
| [CLI](./cli.md)             | `inspect`, `plan`, `graph`, `run`, `history`, and exit codes |
| [Local studio](./studio.md) | Optional run history, `tubeless ui`, and catalogs            |

## Deeper reference

| Document                                                                                         | Use it for                                           |
| ------------------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| [Child-pipeline composition](./child-pipeline-composition.md)                                    | Opaque child and fan-out semantics                   |
| [Generated API inventory](./api-reference.md)                                                    | Entrypoints, exported symbols, and surface hashes    |
| [Machine-readable API report](./api-report.json)                                                 | Automated public-surface review                      |
| [Agent evaluations](https://github.com/chetmancini/tubeless/blob/main/docs/agent-evaluations.md) | Forward-testing the guidance against realistic tasks |
| [LLM index](./llms.txt)                                                                          | Compact machine-readable documentation map           |

The generated API inventory is an audit artifact, not a tutorial. Prefer the
recipe index when deciding how to implement a workflow.
