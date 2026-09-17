# Local studio

Studio is a local browser interface for inspecting pipeline runs. It shows
step status, progress, logs, and errors from a SQLite run store or a saved NDJSON
trace. You can also register pipeline commands to preview and launch them from
the browser. Recording and Studio are optional; pipelines run without either.

## Record and inspect a run

Place `--store` before the command file to record its events in SQLite:

```sh
bunx tubeless run --store .tubeless/runs.sqlite ./scripts/import.ts -- --source rows.txt
bunx tubeless ui --store .tubeless/runs.sqlite
```

The default browser address is `http://127.0.0.1:4317`, and the default store
is `.tubeless/runs.sqlite`. Use `--host`, `--port`, or `--store` to change them.

You can inspect the same records in the terminal:

```sh
bunx tubeless history --store .tubeless/runs.sqlite
bunx tubeless history --json <run-id>
```

To inspect a finished NDJSON trace instead of a database:

```sh
bunx tubeless history --trace run.ndjson
bunx tubeless ui --trace run.ndjson
```

The NDJSON view is always read-only. It cannot launch commands or clear history,
and does not accept a project catalog or `--command`.

## Use the browser controls

The run list shows active runs first, followed by history. Child runs appear
beneath their parent, and caller-owned correlation IDs remain searchable and
visible separately from package-generated run IDs. Open a run to inspect its
steps, progress, logs, and errors.
Nested steps show the child pipeline and its declared steps. Recorded progress
includes the most recent per-item details; when details are truncated, Studio
shows how many were omitted.

| Control       | What it does                                                                      | When available                                                                       |
| ------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Preview plan  | Shows the selected steps and dry-run behavior without starting or recording a run | A pipeline command is registered                                                     |
| Run pipeline  | Validates the form values and starts the command                                  | A command is registered on a loopback host                                           |
| Cancel run    | Aborts the selected live run without stopping Studio or sibling runs              | This Studio process owns the top-level launch                                        |
| Clear history | Deletes all recorded SQLite events and compacts the database after confirmation   | Local SQLite mode with the maintenance capability enabled and no known active writer |

Preview uses the form's dry-run and step/target controls. It does not validate
business inputs; those are checked when you run the command. A preview is
optional. Cancellation affects only a live launch owned by the current Studio
process; it cannot resume or cancel work from an earlier crashed process.

## Register commands for browser execution

Provide command files explicitly:

```sh
bunx tubeless ui \
  --store .tubeless/runs.sqlite \
  --command ./scripts/import.ts \
  --command ./scripts/publish.ts
```

Each file must export a command created with `definePipelineCommand`.
Use `--export` when registering one file with multiple matching exports.
Studio does not infer executable files from recorded runs.

The command's parameter definitions determine the form controls: checkboxes
for booleans, selects for constrained strings, bounded numeric fields, and text
fields for paths and other values. Submitted values go through the command's
normal validation and option mapping. Studio does not construct a shell command.

## Checked-in project manifest

Use a project manifest to register commands once for both the CLI and Studio:

```ts
// tubeless.project.ts
import { definePipelineProject } from "tubeless/project";

export default definePipelineProject({
  cwd: ".",
  commands: [
    {
      id: "import-rows",
      file: "./scripts/import.ts",
      export: "ImportCommand",
      name: "Import rows",
    },
    { id: "publish", file: "./scripts/publish.ts", export: "PublishCommand" },
  ],
});
```

```sh
bunx tubeless list
bunx tubeless inspect import-rows
bunx tubeless run import-rows -- --source rows.txt
bunx tubeless ui --store .tubeless/runs.sqlite ./tubeless.project.ts
```

Command paths and `cwd` are relative to the manifest file. Empty or duplicate
IDs and duplicate module registrations fail when the manifest loads. The
optional `name` changes a display label, not the registered command ID or the
pipeline's own ID.

## Storage behavior

SQLite stores an append-only stream of events. Studio builds run summaries,
step states, logs, and graphs from those events. Normal event updates and
deletes are blocked by database triggers. `clearHistory()` is a separate
maintenance operation that clears the complete history, compacts the database,
and restores the triggers in one transaction.

The SQLite writer buffers events in batches of 64. `export()` can return before
an event reaches disk. Pending events become visible to other connections after
a batch fills, `flush()` runs, the writer calls its own `listEvents` or
`clearHistory`, or the store closes. A crash can lose up to 63 unflushed events.
`tubeless run --store` flushes at completion.

Read-only history and Studio inspect committed events. They refuse databases
with a pending SQLite write-ahead log (`-wal`) or rollback journal (`-journal`),
and files with multiple hard links. A single buffered `export()` does not
create those sidecar files. Finish or close the writer before opening a database
that cannot be read safely.

The local CLI disables clearing while it knows a browser-launched run is active.
Runs left active in history after a process interruption can be cleared after
confirmation. An embedded Studio has no clearing capability unless its caller
supplies one; use `isBusy()` to report other known active writers.

NDJSON readers validate a finished file, assign event IDs in file order, and
close the file. They do not modify the artifact or copy it into SQLite. The
[CLI guide](./cli.md#history) lists file-size, event-size, and event-count limits.
Trace files contain version 2 events with unique execution IDs and separate
reusable correlation IDs.

Recorded definitions come from planned-step events, so Studio can draw graphs
without importing the application. It uses the latest run by
`pipeline.started` timestamp, with store-local ID as a tie-breaker. A newer
planned definition replaces the older steps and targets. A run that fails
validation before planning does not erase the last recorded definition.
Nested metadata includes the declared `stepCount`; truncated progress includes
its original `detailCount`.

## Network access

Studio binds to `127.0.0.1` by default. Browser execution requires a loopback
host: `127.0.0.1`, `::1`, or `localhost`. Binding to another host is rejected
when commands are registered.

Without registered commands, a non-loopback `--host` is allowed but remains
read-only and has no clear-history control. Anyone who can reach that port can
read the store. Logs, errors, and event payloads are displayed without redaction.
Keep the default loopback binding unless you intend to share that data. See
[SECURITY.md](https://github.com/chetmancini/tubeless/blob/main/SECURITY.md).

Studio's HTTP server and browser protocol are internal workbench details, not a
supported embedding API. Use the `tubeless ui` command instead of calling its
local routes directly.
