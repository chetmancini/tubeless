# CLI

Use the `tubeless` CLI to list project commands, inspect a pipeline, preview
which steps will run, execute a command, and inspect recorded results. It
requires Bun 1.3.14 or later and loads TypeScript files directly.

```sh
bunx tubeless --help
npx tubeless --help # Also uses the executable's Bun runtime
```

The executable uses `#!/usr/bin/env bun`, so Bun must be installed and available
on `PATH` even when npm or `npx` installs the package. The library itself can run
on Node.js 22 or later without Bun.

## Commands

### Authoring API

Import terminal commands from `tubeless/cli` and project declarations from
`tubeless/project`:

```ts
import { defineCommand, definePipelineCommand } from "tubeless/cli";
import { definePipelineProject } from "tubeless/project";
```

Use `defineCommand` for a standalone script and `definePipelineCommand` for a
pipeline-backed command with built-in selection, dry runs and terminal reporting.
Both expose typed parsing, validation, descriptors and execution. Their public
configuration, parameter, result and hook types live on the CLI subpath.
Import `PipelineReporterConfig` from `tubeless/cli` to share reporter settings
between commands. Its mode, output stream, color, symbols and terminal-capability
types are exported there too. CLI declarations do not require `@types/node`;
`CliContext.env` accepts a record of string or undefined values.

Use `definePipelineProject` in `tubeless.project.ts` to register command modules
with stable IDs. A project catalog is shared by the terminal and Studio; declaring
one does not load its command modules or start either interface.

| Layer   | Public entry       | Responsibility                                                       |
| ------- | ------------------ | -------------------------------------------------------------------- |
| Core    | `tubeless`         | Typed graphs, planning, execution, hooks and run reports             |
| CLI     | `tubeless/cli`     | Standalone and pipeline commands, typed flags and terminal execution |
| Project | `tubeless/project` | Project catalogs, command IDs and module registrations               |
| Studio  | `tubeless ui`      | Optional browser interface for recorded runs and registered commands |

Users interact with a project through the `tubeless` executable: `list` shows its
commands, `plan` previews work, and `run` executes a command. `ui` opens Studio
against the same catalog. There is no separate workbench application to start.
Core pipelines and standalone CLI commands do not need a project catalog.

Each authoring API has one public entrypoint. Neither the CLI nor the project
catalog import loads storage or Studio. The executable supplies those optional
integrations. Storage readers, Studio's server/protocol, terminal renderer
internals and argument-parser internals remain private.

Import optional filesystem, environment and checkpoint helpers from `tubeless/node`;
see the [Node helpers recipe](./recipes.md#node-helpers). Application-specific
selection prompts belong in the application.

### Executable commands

| Command             | Accepts                             | Does                                                                  |
| ------------------- | ----------------------------------- | --------------------------------------------------------------------- |
| `tubeless list`     | A project manifest                  | Lists explicitly registered command IDs without loading their modules |
| `tubeless validate` | A YAML or JSON pipeline document    | Checks document structure and metadata without loading handlers       |
| `tubeless inspect`  | A pipeline or command export        | Shows the pipeline ID, available targets, steps, and default plan     |
| `tubeless plan`     | A pipeline or command export        | Previews selection without executing or requiring domain options      |
| `tubeless graph`    | A pipeline or command export        | Writes Mermaid flowchart source                                       |
| `tubeless run`      | A `definePipelineCommand` export    | Validates command arguments and runs the pipeline                     |
| `tubeless history`  | An optional run id                  | Lists or shows recorded runs from SQLite or a finished NDJSON trace   |
| `tubeless ui`       | An optional project/Studio manifest | Serves the local run studio; see [studio](./studio.md)                |

Use `tubeless validate [--json] pipelines.yaml` for a fast document-only check.
It supports `.yaml`, `.yml`, and `.json`; it does not resolve handlers, check the
graph, or run domain schemas. See [declarative pipelines](./declarative-pipelines.md)
for the downloadable JSON Schema and validation levels.

Use a checked-in `tubeless.project.ts` to address commands by stable project ID:

```sh
bunx tubeless list
bunx tubeless inspect import-rows
bunx tubeless plan import-rows --target normalized-import --explain
bunx tubeless graph import-rows --markdown
bunx tubeless run import-rows -- --source ../rows.txt --target normalized-import
```

By default, Tubeless looks for `tubeless.project.ts` in the current directory.
It does not search parent directories. Pass `--project <path>` when the manifest
has another name or location.

Without `--project`, an argument naming an existing file is treated as a file.
Otherwise, a bare name can match a registered command ID in the default
manifest. Arguments containing `/`, starting with `.`, or having an extension
are always treated as paths. `--export` applies only when loading a file
directly; a manifest entry already specifies which export to load.

For a file, the CLI selects its only matching export automatically. Pass
`--export Name` when the file exports more than one. `inspect`, `plan`, and
`graph` prefer a marked command when a module exports both a pipeline and a
command.

```sh
bunx tubeless inspect ./scripts/import.ts
bunx tubeless plan ./scripts/import.ts --target normalize --explain
bunx tubeless graph ./scripts/import.ts --markdown
bunx tubeless run ./scripts/import.ts -- --source rows.txt --target normalize
```

For `run`, flags that choose the file or recording destination go before `--`.
Flags passed to the pipeline command go after it, including `--target`,
`--step`, and `--dry-run`. The file must export a `definePipelineCommand`;
call a raw pipeline from application code instead.

```sh
tubeless run --export ImportCommand ./scripts/import.ts -- --source rows.txt --target normalize
```

For command help:

```sh
tubeless run ./scripts/import.ts -- --help
```

## List

```
tubeless list [options]
```

- `-p, --project <path>` selects the manifest (default `./tubeless.project.ts`)
- `--json` emits its version, resolved manifest path, `cwd`, and registrations

`list` evaluates the explicit manifest but does not load any registered command
module. It never scans the filesystem or run history for executables.

## Inspect

```
tubeless inspect [options] <command-id-or-file>
```

- `-e, --export <name>` selects a pipeline or command export
- `-p, --project <path>` looks up the command ID in the selected manifest
- `--json` emits identity and the default plan as JSON

## Plan

```
tubeless plan [options] <command-id-or-file>
```

- `-e, --export <name>` selects a pipeline or command export
- `-p, --project <path>` looks up the command ID in the selected manifest
- `-t, --target <id>` selects a declared target and its prerequisites (repeatable)
- `-s, --step <id>` selects exact internal steps (repeatable)
- `--dry-run` shows whether each step would run, skip, or use a preview handler
- `--explain` explains why each step is selected or omitted
- `--json` emits the structured plan

`--target` includes prerequisites; `--step` selects only the IDs you supply.
They cannot be combined. Planning neither validates business inputs nor runs
step handlers. Use `command.plan()` or `tubeless plan`; there is no command
`--plan` flag.

## Graph

```
tubeless graph [options] <command-id-or-file>
```

- `-e, --export <name>` selects a pipeline or command export
- `-p, --project <path>` looks up the command ID in the selected manifest
- `-d, --direction <value>` is `BT`, `LR`, `RL`, `TB`, or `TD` (default `TD`)
- `--descriptions` includes step descriptions in node labels
- `--markdown` wraps the result in a fenced Mermaid block

The same graph is available in process as `pipeline.toMermaid()` or
`command.toMermaid()`.

## Run

```
tubeless run [options] <command-id-or-file> [-- <command-args...>]
```

- `-e, --export <name>` selects a command export
- `-p, --project <path>` looks up the command ID in the selected manifest
- `--store <path>` appends run events to a local SQLite database
- `--trace <path>` writes NDJSON traces to a file, or `-` for stdout

`--store` and `--trace` can be combined. Traces stay off stdout unless `--trace -`
is set. When `--trace -` is set, the TTY reporter and command result go to
stderr so stdout stays valid NDJSON. To send events to OpenTelemetry or another service, implement a
`PipelineTraceExporter` in your application; the [tracing recipe](../examples/tracing.ts)
shows JSON and OpenTelemetry adapters. Use `composeTraceExporters` from `tubeless/tracing` for multiple
destinations; a failed exporter does not stop the others or fail the pipeline.

`run` accepts only a `definePipelineCommand` export. That export owns parsing,
validation, option mapping, reporting, and the result summary. Omit `mapOptions`
when validated flags already satisfy same-name pipeline options; keep it when
names, types, defaults, or derived values differ. `--step` and `--target` stay
the flag names; the parsed keys are `stepIds` and `targets`.
`--max-concurrency` becomes the numeric `maxConcurrency` control, available to
`mapOptions` and hooks but excluded from the default domain-option mapping.

Start with [`cli-job.ts`](../examples/cli-job.ts) to implement a command.

### Pipeline controls

Pass these flags after `--`, alongside the command's own arguments:

| Flag                         | Effect                                                                   |
| ---------------------------- | ------------------------------------------------------------------------ |
| `--dry-run`                  | Uses each step's dry-run policy; unmarked steps still execute            |
| `--target <id>`              | Runs a declared target and its required dependencies and failure gates   |
| `--step <id>`                | Runs only the specified step IDs; it does not add prerequisites          |
| `--max-concurrency <number>` | Limits simultaneous steps in this run; positive integer, defaults to `1` |
| `--continue-on-error`        | Continues independent work after failure; the run still fails            |

For example, `bunx tubeless run import-rows -- --source rows.txt --max-concurrency 4`
allows up to four ready steps at once. Async skip predicates and output validation
occupy the step's slot. Fail-fast stops new dispatch and waits for active work;
`--continue-on-error` keeps eligible branches running. Child runs have separate
limits: set `maxConcurrency` in child `mapOptions` to opt them in. Parent and fan-out
limits multiply; see [child pipeline composition](./child-pipeline-composition.md).

Repeat `--target` or `--step` to select multiple IDs, but do not combine them.
Check command help for any additional controls and application parameters:

```sh
bunx tubeless run import-rows -- --help
bunx tubeless run import-rows -- --source rows.txt --dry-run
```

A dry run executes safe handlers and custom previews. To inspect selection
without executing any handlers, use `tubeless plan` instead.

## Live log pane

Interactive terminals at least 120 columns wide and 8 rows tall show a small
Logs pane to the right of the progress tree. It follows the latest eight lines
from `context.log`, including warnings and errors, with fewer lines in short
terminals. While the pane is visible, logs appear only there; long lines are
clipped. The pane adapts to terminal resizing and disappears at completion.
When it is hidden, new logs print above progress. Use `--trace` or `--store`
when you need a complete recording.
Narrow terminals, redirected output, and plain reporting keep their usual layout.

The pane is enabled automatically. Configure it per command:

```ts
const command = definePipelineCommand(pipeline, {
  reporter: { logPane: "off" }, // Default: "auto"
});
```

Use `context.log` inside steps, and forward subprocess output to that logger if
you want it in the pane. Direct `console` calls and inherited subprocess output
are not captured. Try `bun examples/live-tui.ts` in a wide terminal.

## Nested progress

In an interactive terminal, child pipelines appear as indented steps:

```text
  ⠋ build-database
    ✓ prepare-artifacts
    ⠋ build-database [████░░░░] 50% 2/4
    · validate-and-promote
```

`fromPipeline` shows child steps; `forEachPipeline` adds an item-key row above
each child's steps. Deeper composition stays nested. Completed rows remain after
parents finish, and failed, cancelled, and skipped work retain distinct states.
Inner progress bars require the child to call `context.reportProgress`; lifecycle
rows work without instrumentation. Tall trees use a live window with omitted-row
counts and print the full retained tree at completion. Fan-out progress snapshots
show at most 32 live item groups by default, prioritizing active items and failures;
the complete tree is emitted once at completion. `progress.detailLimit` overrides
the live cap and caps the final snapshot too. When output is redirected or the terminal is not interactive, the CLI prints
progress summaries.

See [child composition](./child-pipeline-composition.md) for item-group display
limits and [fan-out progress](../examples/fan-out-progress.ts) for an example.

## History

```
tubeless history [options] [run-id]
```

- `--store <path>` selects the SQLite database (default `.tubeless/runs.sqlite`)
- `--trace <path>` selects a finished NDJSON trace artifact
- `--pipeline <id>` filters by the exact recorded pipeline ID, not a registered command ID
- `--json` emits the projected run list, or one projected run when `run-id` is set
- `--events` emits raw store events as NDJSON (run-scoped when `run-id` is set)

`--store` and `--trace` cannot be combined. `--json` and `--events` cannot be
combined. `--pipeline` applies to every output mode and both artifact sources.
With `run-id`, both selectors must match; a mismatch is an unknown run (exit `1`).
A pipeline with no recorded runs returns an empty list or event stream (exit `0`).
History reads recorded IDs directly without loading a project catalog or command module.
By default, history prints a run list. Supply a run ID to see that run's steps,
logs, and error details. A missing store exits `2`. A store also exits `2` with an error if it has a pending SQLite `-wal` or
`-journal` file, has multiple hard links, or is not a supported run store. An unknown run id exits `1`. `tubeless run --store` flushes pending events at completion. A process crash
before a flush can lose up to 63 buffered events. See [storage behavior](./studio.md#storage-behavior)
for programmatic writers and read-only access.
NDJSON files are opened read-only and validated before their events are
displayed. Event IDs start at zero and follow file order. By default, artifacts over 64 MiB, individual event
lines over 1 MiB, and traces over 100,000 events are refused. Diagnostics name
the line and invalid field without echoing its contents. Trace artifacts may
contain sensitive logs, errors, and event payloads; inspect only files you trust and
avoid exposing Studio beyond the intended host.

```sh
bunx tubeless run --store .tubeless/runs.sqlite --trace run.ndjson ./scripts/import.ts -- --source rows.txt
bunx tubeless history
bunx tubeless history --pipeline import
bunx tubeless history --json <run-id>
bunx tubeless history --events <run-id>
bunx tubeless history --trace run.ndjson
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

SIGINT is forwarded through the command context. Help (`--help` or a command's
own help) exits `0`.
