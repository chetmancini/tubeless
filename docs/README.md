# `tubeless` documentation

## Start here

| Document                                | Use it for                                            |
| --------------------------------------- | ----------------------------------------------------- |
| [Package README](../README.md)          | Quick start and capability overview                   |
| [Getting started](./getting-started.md) | Building and running a first pipeline                 |
| [Core concepts](./concepts.md)          | Dependencies, skips, failures, dry runs, and contexts |
| [Recipe index](./recipes.md)            | Choosing an executable example by intent              |
| [Agent guide](./agent-guide.md)         | Rules for generating and modifying pipeline code      |

## Deeper reference

| Document                                                      | Use it for                                           |
| ------------------------------------------------------------- | ---------------------------------------------------- |
| [Child-pipeline composition](./child-pipeline-composition.md) | Opaque child and fan-out semantics                   |
| [Generated API inventory](./api-reference.md)                 | Entrypoints, exported symbols, and surface hashes    |
| [Machine-readable API report](./api-report.json)              | Automated public-surface review                      |
| [Agent evaluations](./agent-evaluations.md)                   | Forward-testing the guidance against realistic tasks |
| [LLM index](./llms.txt)                                       | Compact machine-readable documentation map           |

The generated API inventory is an audit artifact, not a tutorial. Prefer the
recipe index when deciding how to implement a workflow.
