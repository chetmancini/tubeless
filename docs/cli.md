# CLI

The `tubeless` binary inspects, plans, graphs, and runs exported pipeline
modules. It requires Bun 1.3.14 or later. Bun loads TypeScript pipeline
files directly.

```sh
bunx tubeless --help
npx tubeless --help        # Node launcher; relays through Bun automatically
bunx --bun tubeless --help # Bun-only machines: force the Bun runtime
```

Library imports stay dependency-free compiled JavaScript. The CLI is the Bun
workbench around those same exports. The binary's Node shebang makes it
invocable through `npx` and any Node environment; when Bun is missing it
prints install instructions instead of failing with
`env: bun: No such file or directory`. On machines with Bun but no Node,
`bunx` cannot use the Node shebang — pass `--bun` to force the Bun runtime.

## Commands

| Command            | Accepts                          | Does                                                                          |
| ------------------ | -------------------------------- | ----------------------------------------------------------------------------- |
| `tubeless inspect` | A pipeline or command export     | Prints identity (`id`, targets, exact steps) plus the default structural plan |
| `tubeless plan`    | A pipeline or command export     | Previews selection without executing or requiring domain options              |
| `tubeless graph`   | A pipeline or command export     | Writes Mermaid flowchart source                                               |
| `tubeless run`     | A `definePipelineCommand` export | Executes the command's own validated CLI contract                             |
| `tubeless history` | An optional run id               | Lists or shows recorded runs from the local SQLite store                      |
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
- `--trace <path>` writes NDJSON traces to a file, or `-` for stdout

`--store` and `--trace` can be combined. Traces stay off stdout unless `--trace -`
is set. When `--trace -` is set, the TTY reporter and command result go to
stderr so stdout stays valid NDJSON. The binary does not attach OpenTelemetry;
keep that SDK at the application exporter boundary.

`run` accepts only a `definePipelineCommand` export. That export owns parsing,
validation, option mapping, reporting, and the result summary. Omit `mapOptions`
when validated flags already satisfy same-name pipeline options; keep it when
names, types, defaults, or derived values differ. `--step` and `--target` stay
the flag names; the parsed keys are `stepIds` and `targets`.

A first script is [`cli-job.ts`](../examples/cli-job.ts). Local history with
`--store` is covered in [the studio](./studio.md) and `tubeless history`.

## History

```
tubeless history [options] [run-id]
```

- `--store <path>` selects the SQLite database (default `.tubeless/runs.sqlite`)
- `--json` emits the projected run list, or one projected run when `run-id` is set
- `--events` emits raw store events as NDJSON (run-scoped when `run-id` is set)

`--json` and `--events` cannot be combined. The default print is the projection:
a run list, or one run's steps, logs, and error. A missing store exits `2`. An
unknown run id exits `1`.

```sh
bunx tubeless run --store .tubeless/runs.sqlite --trace run.ndjson ./scripts/import.ts -- --source rows.txt
bunx tubeless history
bunx tubeless history --json <run-id>
bunx tubeless history --events <run-id>
```

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
