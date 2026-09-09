# Local studio

Normal pipeline and CLI execution is storage-free. The studio is an optional
local projection of an append-only SQLite event store or a finished NDJSON
trace. Core does not import it.

Record one workbench run by placing `--store` before the command file:

```sh
bunx tubeless run --store .tubeless/runs.sqlite ./scripts/import.ts -- --source rows.txt
```

Inspect recorded runs without a browser:

```sh
bunx tubeless history --store .tubeless/runs.sqlite
bunx tubeless history --json <run-id>
bunx tubeless history --trace run.ndjson
```

Open the studio only when you want a browser view:

```sh
bunx tubeless ui --store .tubeless/runs.sqlite
bunx tubeless ui --trace run.ndjson
```

Both forms can be read-only. The NDJSON form is always read-only: it does not
offer clear-history or accept a studio catalog / `--command`. Studio never
guesses executable modules from recorded definitions. Register marked
`definePipelineCommand` exports to make a
**Run pipeline** action available:

```sh
bunx tubeless ui \
  --store .tubeless/runs.sqlite \
  --command ./scripts/import.ts \
  --command ./scripts/publish.ts
```

`--export` selects the export when you register exactly one `--command`. Launch
forms render each command's structured parameter contract: booleans as
checkboxes, constrained strings as selects, numbers with their bounds, and
paths or unconstrained values as text fields. Submitted values go through the
normal typed command parser without a shell. **Preview plan** uses the dry-run
and stepIds/targets values from the same form; it never creates a run.

Default bind address is `127.0.0.1`, default port is `4317`, and the default
store is `.tubeless/runs.sqlite`. Browser-triggered execution requires a
loopback host (`127.0.0.1`, `::1`, or `localhost`). Non-loopback binding is
rejected when any command is registered. A non-loopback `--host` without
commands is allowed and stays read-only: the store is visible to anyone who
can reach the port, and clear-history is not wired. That bind is a risk you
enable; see [SECURITY.md](https://github.com/chetmancini/tubeless/blob/main/SECURITY.md).
NDJSON traces can include sensitive log messages, structured errors, and
attributes. They are validated and bounded before serving, but their contents
are not redacted; keep Studio on loopback unless disclosure is intentional.
When `--host` is `0.0.0.0` or `::`, a matching `Host` cannot be the bind
address, so the studio also accepts `localhost` or a literal IP on the same
port. DNS names are still refused.

## Checked-in project manifest

Declare stable IDs and module references once for every workbench surface:

```ts
// tubeless.project.ts
import { definePipelineProject } from "tubeless/workbench/project";

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
IDs and duplicate module registrations fail when the manifest loads.
Presentation-name overrides do not change the registered, run, or pipeline
identities. The Studio uses the stable registered ID in its local protocol.

Legacy `definePipelineStudio` catalogs remain accepted by `tubeless ui`; their
historical `file#export` Studio identity is unchanged. They are UI-only and do
not participate in `list`, `inspect`, `plan`, `graph`, or `run` identity lookup.

## What the UI shows

The studio combines active and historical runs in one running-first view. Child
pipeline executions stay beneath their top-level run. Run details include step
attempts, progress, logs, and structured errors. Nested pipeline steps are
labeled with the child pipeline and its declared steps; runtime fan-out is
identified without guessing its item count. Recorded progress keeps the last
per-item `details` rows under the parent bar. Truncated lists keep the original
`detail_count` and nested `step_count` so history can say how many rows were
omitted. A writer's unflushed tail stays in that process; read-only history and
studio inspect committed rows only and refuse after a drain creates a WAL, not
on a single unflushed `export()`. Observed definitions use the latest
`pipeline.started` timestamp, not insert order.

Every studio request, including reads, requires a `Host` header that matches
the bound authority (or, on a wildcard bind, `localhost` or a literal IP on
the same port). Browser plan, launch, cancel, and clear-history also send
`x-tubeless-studio-plan`, `x-tubeless-studio-launch`,
`x-tubeless-studio-cancel`, and `x-tubeless-studio-clear-history`. Plan and
launch require `application/json`. A successful launch response (HTTP 202)
means the run id is already queryable from the store. Cancel aborts one live
studio launch without stopping the server; it is not crash-resume. The Cancel
run control appears only for top-level launches this studio process still owns.
The header names are part of the local studio protocol. They are same-origin
guards, not authentication.

Programmatic callers can compose the same pieces from
`tubeless/run-store/sqlite`, `tubeless/run-store/ndjson`, and
`tubeless/run-store/ui`. See
[`local-observability.ts`](../examples/local-observability.ts).
