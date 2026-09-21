# Local studio

Studio is a local browser interface for inspecting pipeline runs. It shows
step status, progress, logs, and errors from a SQLite run store or a saved NDJSON
trace. You can also load a project or register pipeline commands to preview and launch them from
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
and does not accept a project file or `--command`.

## Use the browser controls

The run list shows active runs first, followed by history. Child runs appear
beneath their parent, and caller-owned correlation IDs remain searchable and
visible separately from package-generated run IDs. Open a run to inspect its
steps, progress, logs, and errors.
Nested steps show the child pipeline and its declared steps. Recorded progress
includes the most recent per-item details; when details are truncated, Studio
shows how many were omitted.

When several steps in a run are active, the run list shows a count such as
“3 steps running” and the first three names, with a remaining count for larger groups.
A single active step keeps its progress message.

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

## Launch project pipelines

Pass a checked-in project file to expose its schema-backed pipelines in Studio:

```ts
// tubeless.project.ts
import { defineProject } from "tubeless/project";
import { ImportPipeline, PublishPipeline } from "./pipelines.js";

export default defineProject("data-jobs", [ImportPipeline, PublishPipeline]);
```

```sh
bunx tubeless ui --store .tubeless/runs.sqlite ./tubeless.project.ts
```

Studio derives the same form fields that the CLI derives as flags. No command
wrapper or catalog is needed.

## Register custom commands for browser execution

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

Pipeline command forms include
**Max Concurrency**, a positive integer defaulting to `1`, under execution controls;
it has the same behavior as the CLI's `--max-concurrency` flag.

## Advanced: checked-in command catalog

Use a command catalog when pipelines need custom CLI inputs, option mapping,
display names, or aliases. It registers those command adapters once for both the CLI and Studio:

```ts
// tubeless.project.ts
import { defineCommandCatalog } from "tubeless/cli";

export default defineCommandCatalog({
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

Command paths and `cwd` are relative to the catalog file. Empty or duplicate
IDs and duplicate module registrations fail when the catalog loads. The
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

## Definition history and comparison

Every compiled pipeline exposes `pipeline.definition`: an immutable, version 1
snapshot with a structural fingerprint and a combined definition ID. Both use
SHA-256. Stable pipeline and step IDs remain the human-facing identity.

Set `implementationVersion` on `definePipeline` to identify handlers, schemas,
mappings, predicates, and the finalizer. Supply a release tag, source revision,
or a digest generated by your build tooling; Tubeless does not inspect function
source or infer code identity. See [the tracing example](../examples/tracing.ts).
An omitted implementation version means **unknown**, even when fingerprints match.

The structural fingerprint includes compiled execution order, step IDs, required
and optional edges, failure gates, targets, dry-run and skip policies, schema
presence, required finalizer steps, child composition and concurrency, and remote
engine/target metadata. Dependency, target, and required-finalizer sets are sorted. Names, descriptions,
progress presentation, inputs, run controls, and handler code are excluded.
Changing the implementation version changes the combined definition ID without
changing the structural fingerprint. Child structural identities propagate into
the parent's fingerprint; child implementation identities propagate only into its
combined ID. The combined ID binds every recorded child identity field, including
its implementation version; changing that metadata while keeping the child's ID
unchanged invalidates the parent snapshot. Child internals still require the child's
own snapshot to inspect. Dynamic policies are represented by their presence, not their code
or runtime return values. Remote handler versions belong in the application-supplied
implementation version. External pipeline implementations without definition metadata
contribute only their declared child IDs and composition metadata.

In Studio's Runs view, **Observed definitions** groups recordings by pipeline ID
and definition ID. Select a definition to see its runs. **Compare from** shows
changes from another observed version of the same pipeline to the selected version:
added/removed steps, execution order, edges, targets, policies, validation boundaries,
child/remote metadata, and implementation versions. Child steps stay opaque wrappers;
compare the child's own recorded definitions for its internal graph changes.
Run details show the identity that actually produced that run.

The version 2 `pipeline.started` payload adds optional `definitionIdentity` and
`definitionSnapshot` fields. The identity is retained even when selection or input
validation fails before step events. A snapshot is limited to 256 KiB of UTF-8 JSON,
4,096 steps or entries per list, 4,096 code units per identifier, and the existing
remote metadata limits. Implementation versions are nonblank strings of at most
256 code units. Snapshots exceeding these limits are omitted in full; their identity
still fingerprints the complete graph. Studio declines comparisons when either
snapshot is unavailable. These limits affect recording, not pipeline execution.

Existing version 2 recordings remain readable. Runs without these optional fields
are labeled legacy, with no invented identity. Their latest planned-step graph is
still retained per pipeline using the start timestamp and store-local event ID.
The trace version stays at 2; the definition identity's own version fixes fingerprint
semantics. Unsupported identity versions are rejected by current readers. Older
Tubeless readers ignore the new optional fields; external strict schema validators
must update their schema before consuming them.

NDJSON and SQLite readers recompute both hashes from each complete definition
snapshot and reject mismatches before projecting history. SQLite also checks writes.
Hash checks establish consistency with the recorded snapshot, not authenticity of
handler code or the recording's source. Identity-only records cannot be checked
without their omitted snapshots.

Definitions are projected from the same append-only events as runs, without loading
application modules. They remain available for as long as their run events remain;
there is no separate orphan-definition retention period. Clear history removes both
runs and observed definitions. Nested metadata retains `stepCount`, and truncated
progress retains its original `detailCount`.

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
