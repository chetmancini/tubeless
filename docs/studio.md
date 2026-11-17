# Studio

Studio is a browser interface for inspecting pipeline runs from a SQLite run store
or a saved NDJSON trace. You can also load a project or register commands to preview
and launch pipelines from the browser. It runs locally by default and can be hosted
behind an authenticated application gateway. Recording and Studio are optional;
pipelines run without either.

## Record and inspect a run

Place `--store` before the command file to record events in SQLite, then open Studio:

```sh
bunx tubeless run --store .tubeless/runs.sqlite ./scripts/import.ts -- --source rows.txt
bunx tubeless ui --store .tubeless/runs.sqlite
```

The default address is `http://127.0.0.1:4317` and the default store is
`.tubeless/runs.sqlite`; change them with `--host`, `--port`, and `--store`. The same
records are available in the terminal through `tubeless history` (see the
[CLI](./cli.md#history)).

To inspect a finished NDJSON trace instead:

```sh
bunx tubeless ui --trace run.ndjson
```

The NDJSON view is always read-only: no launching, no clearing history, and no
project file or `--command`.

### Agent transcripts

Agent runs in SQLite history get a **Transcript** tab showing prompts, public
assistant text, decisions, tool calls and results, and explicit omissions, with
**Open turn** links back to the structural run. Content appears when it was captured
with `agent --store <path> --capture-transcript`, imported with
`history --store <path> --import-transcript <path>`, or written by a
[Cloudflare transcript writer](./deploy-cloudflare.md#opt-in-agent-transcripts).
Opening the tab never enables capture. Partial transcripts refresh while visible.
Clearing history deletes stored content atomically with it.

`--transcript <path>` attaches a finished transcript file to either event source as
an immutable snapshot; restart Studio to see later appends. Clearing history is
disabled while one is attached, and the API never exposes its path. See
[save and inspect a transcript](./agents.md#save-and-inspect-a-transcript).

## Use the browser controls

Studio reads top-down: pick a pipeline, open a run, select a step.

- **Activity** is the home page: running work, recorded runs and success rate, then
  top-level runs across pipelines with active runs first, in pages of 50. Search
  matches run IDs, pipeline IDs, and correlation IDs anywhere in a run's subtree.
- The **sidebar** lists registered commands and pipelines with recorded top-level
  runs, with each one's latest outcome and recent runs. Pipelines that only ran as
  children are grouped under **Nested pipelines**.
- A **pipeline page** has **Runs** (at any depth, newest first), **Graph** (declared
  steps from the latest recorded definition, or the current plan if it never ran),
  **Versions** (recorded definitions and comparison), and **Run** (the launch form,
  when a command is registered).
- A **run page** leads with a one-line outcome and error diagnostics, then **Steps**,
  **Logs**, **Nested runs**, and **Details** (IDs, event count, definition identity).
  A breadcrumb walks from the top-level run through nested runs.
- Selecting a step opens the **inspector**: outcome, skip explanation, timing,
  retries, inputs and consumers, artifacts, progress items, the step's logs, and the
  nested runs it started.

Errors name the failing steps and show validation issue paths, expandable cause
chains, and failed fan-out items. Skipped steps say why they did not run. Logs can be
searched and filtered by level and step. Diagnostics are limited to the selected run;
open a nested run to see its own.

The URL records where you are (`?pipeline=<id>`, `&tab=graph|versions`,
`?run=<run-id>`, `&step=<step-id>`), and the copy icon on a run copies a link to it.
Links work only with the same Studio mount and run store.

Some recordings carry annotations:

- Test-runtime overrides appear as `completed (overridden)` and similar; supplied
  values are not recorded, and launch forms accept no overrides
  ([testing overrides](./concepts.md#supplying-step-outputs)).
- Cache hits keep their ordinary status with `(cached)`; keys and values are not
  recorded ([step output caching](./step-output-cache.md)).
- Artifact steps show recorded reads, writes, verified reuse, and dry-run previews.
  Completed I/O stays visible if a later step fails ([artifacts](./artifacts.md)).

The **Graph** toggle beside the step timeline draws the run top to bottom: circles are
steps, arrows run from a dependency to its consumer. Solid arrows are required
inputs, thinner arrows optional ones, dashed arrows candidate inputs not yet used,
and dotted arrows failure gates (red when tripped). Steps with nested runs carry a
count badge; select it to expand fan-out items, iterations, agent turns, and tool
calls in place (up to six levels deep and sixteen items per step at a time).
Recordings made before dependencies were recorded show steps without arrows.

| Control       | What it does                                                                  | When available                                                       |
| ------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Preview plan  | Shows selected steps and dry-run behavior without starting or recording a run | A pipeline command is registered                                     |
| Run           | Validates the form values, starts the command, and opens the new run          | A command is registered locally or in gateway mode                   |
| Cancel run    | Aborts the selected live run without stopping Studio or sibling runs          | This Studio process owns the top-level launch                        |
| Clear history | Deletes all recorded SQLite events after confirmation and attempts compaction | Local SQLite mode with no known active writer; never in gateway mode |

Preview uses the form's dry-run and step/target controls and does not validate
business inputs; those are checked at run time. Cancellation affects only launches
owned by the current process and cannot resume or cancel work from a crashed one.
**Resume** appears only when the command declares managed `checkpoint` support or
application-owned `resume: true`.

## Launch project pipelines

Pass a project file to expose its schema-backed pipelines in Studio:

```ts
// tubeless.project.ts
import { defineProject } from "tubeless/project";
import { ImportPipeline, PublishPipeline } from "./pipelines.js";

export default defineProject("data-jobs", [ImportPipeline, PublishPipeline]);
```

```sh
bunx tubeless ui --store .tubeless/runs.sqlite ./tubeless.project.ts
```

Studio derives the same form fields the CLI derives as flags, and project selection
follows the CLI's [rules](./cli.md#selecting-a-project-pipeline-or-file). Automatic
registration needs Standard JSON Schema input metadata; register explicit command
adapters in the project entry list for schema-less pipelines or custom inputs. See
the [complete project example](../examples/project/tubeless.project.ts).

Form controls come from the command's parameters: checkboxes for booleans, selects
for constrained strings, bounded numeric fields, text for paths. Submitted values
pass through the command's normal validation and option mapping; Studio never builds
a shell command. Pipeline inputs come first, with execution controls (dry run, step
and target selection, cache, failure handling, **Max Concurrency**) folded beneath
them, defaulting to one run of every step.

## Register command files

Without a project, register command files explicitly:

```sh
bunx tubeless ui \
  --store .tubeless/runs.sqlite \
  --command ./scripts/import.ts \
  --command ./scripts/publish.ts
```

Each file may export a `definePipelineCommand` command or one unique schema-backed
pipeline. An explicit command wins; use `--export` when registering one file with
several matching exports. Studio never infers executables from recorded runs.

## Storage behavior

SQLite stores an append-only stream of events; Studio builds runs, step states, logs,
and graphs from them. Database triggers block normal updates and deletes.
`clearHistory()` is a separate maintenance operation that deletes everything and
restores the triggers in one transaction; a failure rolls back, and compaction is
best-effort afterwards.

- **Schema upgrades.** `tubeless run --store`, `tubeless ui`, and
  `tubeless history --clear` refuse an older store. Run
  `tubeless upgrade --yes --store <path>` first ([CLI](./cli.md#upgrade)). Read-only
  opens of versions 1 through 3 work without writing.
- **Buffering.** The writer batches 64 events. `export()` can return before an event
  reaches disk; events become visible to other connections when a batch fills,
  `flush()` runs, the writer lists or clears events, or the store closes.
  `tubeless run --store` flushes at completion, but a crash can lose up to 63
  buffered events.
- **Read-only access.** History and Studio read committed events and refuse
  databases with a pending `-wal` or `-journal` file or multiple hard links. Close the
  writer before opening such a database.
- **Clearing.** The local CLI disables clearing while it knows a browser-launched run
  is active. Gateway mode always disables it.
- **NDJSON.** Readers validate the finished file, assign event IDs in file order, and
  never modify it. Size limits are in the [CLI guide](./cli.md#history). New traces
  contain version 3 events with unique execution IDs; version 2 traces are still
  readable.

Studio's server and JSON payloads are internal and version-coupled. Use the CLI and
the hosting contract below rather than building against its routes.

## Definition history and comparison

Every compiled pipeline exposes `pipeline.definition`: an immutable snapshot with a
structural fingerprint and a combined definition ID (both SHA-256). Studio's
**Versions** tab groups a pipeline's recordings by definition ID, shows each
definition's runs, and **Compare from** diffs another observed version against the
selected one: steps, order, edges, targets, policies, validation boundaries,
child/remote metadata, and implementation versions. Run details show the identity
that actually produced the run. Runs recorded without a definition are labeled
legacy.

Set `implementationVersion` on `definePipeline` to identify handlers, schemas,
mappings, and predicates. Use a release tag, source revision, or build digest;
Tubeless does not inspect function source. An omitted implementation version means
**unknown**, even when fingerprints match. See [the tracing example](../examples/tracing.ts).

What the fingerprint covers:

- Included: execution order, step IDs, required and optional edges, failure gates,
  targets, dry-run and skip policies, schema presence, cache settings, finalizer
  requirements, child composition and concurrency, remote metadata, and
  [graph metadata](./graph-metadata.md).
- Excluded: names, descriptions, progress presentation, inputs, per-run controls, and
  handler code. Dynamic policies are represented by presence, not behavior.
- Changing `implementationVersion` changes the combined ID but not the fingerprint.
  Child structure propagates into the parent's fingerprint; child steps stay opaque
  wrappers, so compare the child's own definitions for its internals.

Snapshots ride on the `pipeline.started` event, limited to 256 KiB of JSON and
4,096 steps. An oversized snapshot is omitted whole (its identity still covers the
full graph) and Studio declines comparisons that need it. Readers recompute hashes
and reject mismatches; this proves consistency with the recorded snapshot, not the
authenticity of handler code. Definitions live as long as their run events, and
clearing history removes both.

## Network access

Studio binds to `127.0.0.1` by default. Without gateway mode, browser execution
requires `127.0.0.1`, `::1`, or `localhost`. A non-loopback `--host` without commands
is read-only, but anyone who can reach the port can read its history. Logs, errors,
and payloads are displayed without redaction.

## Host Studio behind an application gateway

Run one long-lived Studio process behind your application's authenticated admin
route. Tubeless owns the mount, gateway authentication, recorded history, and
command execution. Your application owns login, sessions, admin permission checks,
TLS, private networking, and which commands are registered. Every admitted user sees
the whole store and command catalog: this is one admin trust domain with no per-user
isolation or audit trail. To host Studio on Cloudflare without your own gateway, see
[Deploy to Cloudflare](./deploy-cloudflare.md).

Provision `TUBELESS_STUDIO_GATEWAY_TOKEN` as 32 random bytes encoded as 64 hex
characters, shared only between the gateway and Studio. Never put it in argv,
browser code, URLs, logs, or cookies. Studio reads it once at startup and removes it
from its environment so launched commands do not inherit it. Then start Studio:

```sh
tubeless ui --host 0.0.0.0 --port 4317 \
  --public-url https://example.com/admin/pipelines \
  --store /data/tubeless/runs.sqlite ./tubeless.project.ts
```

`--public-url` enables gateway mode; the environment variable alone is an error, and
bad configuration fails before user modules load. The URL must be absolute HTTPS
(HTTP only for literal loopback development), with plain path segments and no
credentials, query, or fragment. Root mounts work.

The gateway **preserves the complete mount prefix**: `/admin/pipelines/` serves the
page and `/admin/pipelines/api/...` serves browser requests; there is no
prefix-stripping mode. Link to the full Studio page from your admin navigation:
`frame-ancestors 'none'` prevents iframe embedding.

### Gateway request contract

For every page and API request, before contacting Studio:

1. Verify the application session and pipeline-admin permission in the request
   handler. Protecting an admin page or layout alone is insufficient.
2. Forward only to a fixed private upstream, never a browser-selected URL. Replace
   incoming `Authorization` with `Bearer <backend-token>`; never forward browser
   credentials or cookies.
3. Set `Host` to the configured public authority (including a nondefault port), even
   when the TCP destination is private. Forwarded host, identity, and protocol
   headers grant nothing.
4. For POST/DELETE, verify the browser `Origin` equals the configured public origin
   and preserve it when forwarding. Studio rejects a missing, null, duplicate, or
   foreign Origin. Preserve the UI's JSON content type and `x-tubeless-studio-*`
   headers. There is no CORS mode; GET/HEAD navigation may omit Origin.
5. Preserve response status, content type, CSP, and `Cache-Control: no-store`, and
   exclude the mount from service-worker and shared-cache handling. Do not retry
   launches or other mutations: an uncertain response may already have had effects,
   and there is no replay contract.

For trusted self-hosted Cloudflare code, use the
[programmatic launch capability](./deploy-cloudflare.md#launch-from-application-code)
with an idempotency key instead. Self-hosted Cloudflare Studio also records launch
attribution and allowlisted inputs, and **Run again** in a run's Details tab opens a
prefilled form for a fresh launch; see
[Cloudflare launch history](./deploy-cloudflare.md#attribution-input-history-and-run-again).

Studio checks the backend credential on **every** route, including pages, redirects,
unknown paths, and readiness, before parsing bodies or touching the store. Only the
gateway should be publicly routed. Bind Studio to loopback in the same container, or
to a private network the gateway can reach; a bearer token does not encrypt HTTP, so
use encrypted transport across that network. There is no option to disable host
checks.

### Access expiry and failures

The gateway may redirect page navigation to its login flow, but API requests must
return JSON **401** (login needed) or **403** (permission denied), never a login HTML
page. After either, Studio clears displayed data, suspends polling, and disables
actions until **Open Studio again** performs a full navigation through the gateway.

A backend credential denial is an integration failure: map it to a generic **502**
rather than logging the user out. Network errors and 5xx responses show an error
state and never retry a mutation automatically.

### Process, persistence, and readiness

Use a persistent volume for the SQLite store and one active Studio writer per store.
You own supervision, backups, resource limits, and rollouts. NDJSON stays read-only
in gateway mode.

Authenticated `GET <mount>/api/health` returns `200 {"ready":true}` after startup and
`503 {"ready":false}` once shutdown begins. There is no unauthenticated health
bypass: an exec probe must supply the credential, or your application can expose a
minimal health facade.

A launch acknowledgement means the start event was persisted. It is not a durable job
queue or a completion guarantee across crashes, and a browser disconnect does not
cancel the run. Cancellation is cooperative and process-local; a restarted process
can inspect older runs but cannot cancel or resume them.

On shutdown the CLI stops admission, aborts active launches, closes the listener,
drains executions, then flushes and closes storage. Handlers should observe the
cancellation signal; an uncooperative handler can stall draining, so your supervisor
owns the grace period, and forced termination can lose buffered events. Horizontal
execution, multiwriter SQLite, scheduling, crash recovery, and per-user stores are
outside this contract.

### Application handoff

Upgrade to a tested Tubeless release, enforce session and admin checks in every
forwarding handler, configure a fixed upstream and the backend token, register an
explicit deployment-specific command catalog (a local catalog may contain seeding or
filesystem commands unsuitable for deployment), and provision persistent storage and
a supervised process. Keep framework, auth-provider, and hosting configuration in the
application. The repository's proxy integration tests exercise this contract; they do
not prove your gateway is configured correctly. See
[SECURITY.md](https://github.com/chetmancini/tubeless/blob/main/SECURITY.md).

Previews and recorded versions also expose [graph metadata](./graph-metadata.md):
expand **Explore steps** on the Versions tab to search it and group by owner or
domain.
