# CLI

The `tubeless` binary inspects, plans, graphs, and runs exported pipeline
modules. It requires Bun 1.3.14 or later (`#!/usr/bin/env bun`). Bun loads
TypeScript pipeline files directly. `npx tubeless` is not supported.

```sh
bunx tubeless --help
```

Library imports stay dependency-free compiled JavaScript. The CLI is the Bun
workbench around those same exports.

## Commands

| Command            | Accepts                          | Does                                                                          |
| ------------------ | -------------------------------- | ----------------------------------------------------------------------------- |
| `tubeless inspect` | A pipeline or command export     | Prints identity (`id`, targets, exact steps) plus the default structural plan |
| `tubeless plan`    | A pipeline or command export     | Previews selection without executing or requiring domain options              |
| `tubeless graph`   | A pipeline or command export     | Writes Mermaid flowchart source                                               |
| `tubeless run`     | A `definePipelineCommand` export | Executes the command's own validated CLI contract                             |
| `tubeless ui`      | An optional studio catalog       | Serves the local run studio; see [studio](./studio.md)                        |

The workbench discovers a single matching export automatically. Pass
`--export Name` when the file exports more than one. `inspect`, `plan`, and
`graph` prefer a marked command when a module exports both a pipeline and a
command.

```sh
bunx tubeless inspect ./scripts/import.ts
bunx tubeless plan ./scripts/import.ts --target normalize --explain
bunx tubeless graph ./scripts/import.ts --markdown
bunx tubeless run ./scripts/import.ts -- --source rows.txt --target normalize
```

Workbench flags stay before `--`. Application flags belong after it.
`tubeless run` never executes a raw pipeline or guesses domain options.

```sh
tubeless run --export ImportCommand ./scripts/import.ts -- --source rows.txt --target normalize
```

For command help:

```sh
tubeless run ./scripts/import.ts -- --help
```

## Inspect

```
tubeless inspect [options] <pipeline-or-command-file>
```

- `-e, --export <name>` selects a pipeline or command export
- `--json` emits identity and the default plan as JSON

## Plan

```
tubeless plan [options] <pipeline-or-command-file>
```

- `-e, --export <name>` selects a pipeline or command export
- `-t, --target <id>` selects a declared target and its prerequisites (repeatable)
- `-s, --step <id>` selects exact internal steps (repeatable)
- `--dry-run` shows each step's dry-run disposition
- `--explain` includes target/dependency selection provenance
- `--json` emits the structured plan

Do not simulate planning with a `--plan` flag on the command itself. Use
`command.plan()` or `tubeless plan`. `--target` and `--step` cannot be combined.

## Graph

```
tubeless graph [options] <pipeline-or-command-file>
```

- `-e, --export <name>` selects a pipeline or command export
- `-d, --direction <value>` is `BT`, `LR`, `RL`, `TB`, or `TD` (default `TD`)
- `--descriptions` includes step descriptions in node labels
- `--markdown` wraps the result in a fenced Mermaid block

The same graph is available in process as `pipeline.toMermaid()` or
`command.toMermaid()`.

## Run

```
tubeless run [options] <command-file> [-- <command-args...>]
```

- `-e, --export <name>` selects a command export
- `--store <path>` appends run events to a local SQLite database

`run` accepts only a `definePipelineCommand` export. That export owns parsing,
validation, option mapping, reporting, and the result summary. Omit `mapOptions`
when validated flags already satisfy same-name pipeline options; keep it when
names, types, defaults, or derived values differ.

A first script is [`cli-job.ts`](../examples/cli-job.ts). Local history with
`--store` is covered in [the studio](./studio.md).

## Exit codes

| Code | Meaning      |
| ---- | ------------ |
| `0`  | Success      |
| `1`  | Usage        |
| `2`  | Load         |
| `3`  | Definition   |
| `4`  | Validation   |
| `5`  | Planning     |
| `6`  | Execution    |
| `7`  | Cancellation |

These values are also exported as `TUBELESS_WORKBENCH_EXIT_CODE` from
`tubeless/cli`. SIGINT is forwarded through the command context. Help (`--help`
or a command's own help) exits `0`.
