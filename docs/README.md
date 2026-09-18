# Tubeless documentation

Tubeless provides typed execution pipelines for data processing, application
workflows, and AI workloads. Start with a small pipeline, then choose the
controls and integrations your work needs. The guides link to examples you can
adapt in your project.

## Start here

| Document                                                    | Use it for                                            |
| ----------------------------------------------------------- | ----------------------------------------------------- |
| [Website](https://tubeless.io/)                             | Guides for developers and coding agents               |
| [Package README](../README.md)                              | What it is, a first example, and a pattern table      |
| [Getting started](./getting-started.md)                     | Building, running, and testing a first pipeline       |
| [Recipe index](./recipes.md)                                | Finding a working example for your task               |
| [Project manifest](../examples/catalog/tubeless.project.ts) | Registering commands and choosing a file layout       |
| [Core concepts](./concepts.md)                              | Dependencies, skips, failures, dry runs, and contexts |
| [Agent guide](./agent-guide.md)                             | Rules for generating and modifying pipeline code      |
| [Comparison](./comparison.md)                               | How Tubeless fits next to other job runners           |

## How to

Install the [agent skill pack](./agent-skills.md) to author pipelines or convert existing code.

| Document                                              | Use it for                                                            |
| ----------------------------------------------------- | --------------------------------------------------------------------- |
| [CLI](./cli.md)                                       | `list`, `inspect`, `plan`, `graph`, `run`, `history`, and exit codes  |
| [Local studio](./studio.md)                           | Optional run history, `tubeless ui`, and catalogs                     |
| [YAML and JSON pipelines](./declarative-pipelines.md) | Compile documents with registered handlers, skips, and child adapters |

## Deeper reference

For agent or editor validation, use the [pipeline document JSON Schema](./pipeline-document.schema.json).

| Document                                                      | Use it for                                         |
| ------------------------------------------------------------- | -------------------------------------------------- |
| [Child-pipeline composition](./child-pipeline-composition.md) | Running a reusable pipeline once or for many items |
| [Remote-step composition](./remote-step-composition.md)       | Calling remote services and running inside workers |
| [Generated API inventory](./api-reference.md)                 | Entrypoints, exported symbols, and surface hashes  |
| [Machine-readable API report](./api-report.json)              | Automated public-surface review                    |
| [LLM index](./llms.txt)                                       | Documentation links for coding agents              |

Use the recipe index to choose an implementation pattern. Use the generated
API inventory to check exported names and signatures.
