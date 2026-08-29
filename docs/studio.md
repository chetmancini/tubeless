# Local studio

Normal pipeline and CLI execution is storage-free. The studio is an optional
local projection of an append-only SQLite event store. Core does not import it.

Record one workbench run by placing `--store` before the command file:

```sh
bunx tubeless run --store .tubeless/runs.sqlite ./scripts/import.ts -- --source rows.txt
```

Open the studio only when you want a browser view:

```sh
bunx tubeless ui --store .tubeless/runs.sqlite
```

That form is read-only. It does not guess executable modules from recorded
definitions. Register marked `definePipelineCommand` exports to make a
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
and step/target values from the same form; it never creates a run.

Default bind address is `127.0.0.1`, default port is `4317`, and the default
store is `.tubeless/runs.sqlite`. Browser-triggered execution requires a
loopback host (`127.0.0.1`, `::1`, or `localhost`). Non-loopback binding is
rejected when any command is registered. A non-loopback `--host` without
commands is allowed and stays read-only: the store is visible to anyone who
can reach the port, and clear-history is not wired. That bind is a risk you
enable; see [SECURITY.md](https://github.com/chetmancini/tubeless/blob/main/SECURITY.md).

## Checked-in catalog

Declare module references once for a repeatable project catalog:

```ts
// tubeless.studio.ts
import { definePipelineStudio } from "tubeless/workbench/studio";

export default definePipelineStudio({
  cwd: ".",
  commands: [
    { file: "./scripts/import.ts", export: "ImportCommand", name: "Import rows" },
    { file: "./scripts/publish.ts", export: "PublishCommand" },
  ],
});
```

```sh
bunx tubeless ui --store .tubeless/runs.sqlite ./tubeless.studio.ts
```

Command paths and `cwd` are relative to the manifest file. Empty or duplicate
registrations fail before the studio starts. Presentation-name overrides do not
change run or pipeline identity.

## What the UI shows

The studio combines active and historical runs in one running-first view. Child
pipeline executions stay beneath their top-level run. Run details include step
attempts, progress, logs, and structured errors. Nested pipeline steps are
labeled with the child pipeline and its declared steps; runtime fan-out is
identified without guessing its item count. Recorded progress keeps the last
per-item `details` rows under the parent bar. Truncated lists keep the original
`detail_count` and nested `step_count` so history can say how many rows were
omitted.

Browser plan, launch, cancel, and clear-history requests send
`x-tubeless-studio-plan`, `x-tubeless-studio-launch`,
`x-tubeless-studio-cancel`, and `x-tubeless-studio-clear-history`. Those
requests also require a `Host` header that matches the bound authority, and
plan/launch require `application/json`. A successful launch response (HTTP 202)
means the run id is already queryable from the store. Cancel aborts one live
studio launch without stopping the server; it is not crash-resume. The header
names are part of the local studio protocol. They are same-origin guards, not
authentication.

Programmatic callers can compose the same pieces from
`tubeless/run-store/sqlite` and `tubeless/run-store/ui`. See
[`local-observability.ts`](../examples/local-observability.ts).
