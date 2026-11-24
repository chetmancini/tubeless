# CLI

Use the `tubeless` CLI to list project pipelines, inspect and plan them, run them,
and read recorded results. It requires Bun 1.3.14 or later and loads TypeScript
files directly.

```sh
bunx tubeless --help
npx tubeless --help # Starts on Node.js, then hands off to Bun
```

Bun must be on `PATH` even when npm or `npx` installs the package; otherwise the
command says what to install and exits 1. The library itself runs on Node.js 22.18
or later without Bun.

## Commands

| Command               | Accepts                          | Does                                                                |
| --------------------- | -------------------------------- | ------------------------------------------------------------------- |
| `tubeless list`       | A project file                   | Lists project pipeline IDs with their names and descriptions        |
| `tubeless validate`   | A YAML or JSON pipeline document | Checks document structure and metadata without loading handlers     |
| `tubeless inspect`    | A pipeline or command export     | Shows identity, targets, and the default structural plan            |
| `tubeless plan`       | A pipeline or command export     | Previews selection without executing or requiring domain options    |
| `tubeless graph`      | A pipeline or command export     | Writes Mermaid flowchart source                                     |
| `tubeless run`        | A pipeline ID or command export  | Infers or validates command arguments and runs the pipeline         |
| `tubeless history`    | An optional run id               | Lists or shows recorded runs from SQLite or a finished NDJSON trace |
| `tubeless upgrade`    | An optional `--store` path       | Rewrites an older SQLite run store after `--yes`                    |
| `tubeless ui`         | An optional project file         | Serves the local run studio; see [studio](./studio.md)              |
| `tubeless agent`      | An optional agent ID or file     | Prompts a workspace agent; see [agent](#prompt-a-workspace-agent)   |
| `tubeless auth`       | `login`, `status`, `logout`      | Manages Tubeless Cloud sessions                                     |
| `tubeless cloud`      | Cloud runs or a saved manifest   | Operates on [Cloud runs](#tubeless-cloud) and reproduces checks     |
| `tubeless completion` | `bash`, `zsh`, or `fish`         | Prints a shell completion script                                    |
| `tubeless init`       | An optional target               | Scaffolds a project or deployment files; see [init](#init)          |

`tubeless <command> --help` lists every flag. This page covers the ones that carry
a contract.

## Turn a pipeline into a CLI

Start with one import and one call:

```ts
import { definePipelineCommand } from "tubeless/cli";
import { pipeline } from "./pipeline.js";

export const command = definePipelineCommand(pipeline);

if (import.meta.main) void command.main();
```

The pipeline's options schema is the source of truth. When the schema passed to
`createSteps(schema)` exposes [Standard JSON Schema](https://standardschema.dev/json-schema)
input metadata, the command derives domain flags automatically. See the
[executable example](../examples/automatic-cli.ts) and its
[pipeline schema](../examples/validated-boundaries.ts).

| Pipeline input                | Generated CLI                                   |
| ----------------------------- | ----------------------------------------------- |
| `displayName: string`         | Required `--display-name <value>`               |
| Optional string or number     | Optional flag                                   |
| String enum                   | Flag with checked choices and help text         |
| Number or integer             | Plain decimal, with minimum/maximum checks      |
| Boolean                       | `--enabled` / `--no-enabled`; defaults to false |
| String or number array        | Repeatable flag; defaults to `[]`               |
| Scalar default or description | Default value or help text                      |

Every command also supplies `--help`, `--dry-run`, `--step`, `--target` (when the
pipeline declares targets), `--continue-on-error`, `--max-concurrency`, terminal
reporting, cancellation, and [exit codes](#exit-codes). `command.main()` owns a
script entrypoint; `command.run(argv)` returns the result to application code;
`command.plan()` previews selection. The same descriptor drives Studio forms.

Inference reads the schema's **input**, so transformations run once, during
execution. Parsing checks flag types, choices and numeric bounds; the pipeline
still performs full domain validation before running steps. Help and planning
never validate domain input or run steps.

Explicit `params` are required when inference cannot work:

- The pipeline uses `createSteps<MyOptions>()` (types leave no runtime fields). One
  with no domain inputs works with the one-argument call.
- The schema is validation-only, or has nested objects, nullable/union inputs,
  tuples, array defaults, or numeric/boolean `enum`/`const` constraints.
  Unsupported shapes fail at command creation with guidance.
- A local `$ref` has validation siblings such as `properties` or `minimum`.
  Annotation siblings (`description`, `default`) are fine.

### Override or replace the derived flags

Use `overrides` when a derived flag needs a different name, short alias, environment
fallback, or help text. Type and validation still come from the schema:

```ts
const command = definePipelineCommand(pipeline, {
  overrides: {
    source: { short: "s", env: "IMPORT_SOURCE", description: "Input source." },
  },
});
```

Explicit arguments beat environment fallbacks. Other optional settings are `name`,
`description`, `positionals`, `summarize`, `hooks`, `checkpoint`, `resume`, and
`reporter`.

Use `params` when the command inputs intentionally differ from pipeline options. It
replaces inference completely and cannot be combined with `overrides`. Add
`mapOptions` only when inputs need renaming, conversion, I/O, or derived values:

```ts
const command = definePipelineCommand(pipeline, {
  params: { source: { type: "path", mustExist: true, kind: "file" } },
  mapOptions: (values) => ({ lines: readFileSync(values.source, "utf8").split("\n") }),
});
```

See [`cli-job.ts`](../examples/cli-job.ts) for the complete file-to-rows mapping.
`--step` and `--target` stay the flag names; the parsed keys are `stepIds` and
`targets`. `--max-concurrency` becomes the numeric `maxConcurrency` control,
available to `mapOptions` and hooks but not mapped into domain options.
`defineCommand` is the lower-level alternative for standalone scripts without a
pipeline.

`--resume` exists only when the command opts in. Configure `checkpoint` to expose
the flag and supply a managed store, which steps read as `context.checkpoint` (child
pipelines inherit it; dry runs get an in-memory view so nothing is written). Set
`resume: true` instead when application code owns resume state and reads
`values.resume`. Commands with neither reject `--resume`, and Studio renders no
resume control.

## Projects

Put `defineProject(id, pipelines)` from `tubeless/project` in `tubeless.project.ts`.
The CLI and Studio find pipelines by ID and derive commands for schema-backed ones,
so no command wrapper is needed:

```ts
import { defineProject } from "tubeless/project";
import { ImportPipeline, PublishPipeline } from "./pipelines.js";

export default defineProject("data-jobs", [ImportPipeline, PublishPipeline], {
  name: "Data jobs",
  description: "Import source data and publish normalized datasets.",
});
```

The optional third argument sets the project `name` (defaults to the ID) and
`description`; `list --json` includes both. For custom parameters or presentation,
put `definePipelineCommand` adapters in the same entry list:

```ts
const ImportCommand = definePipelineCommand(ImportPipeline, {
  params: { lines: { type: "string", multiple: true } },
  name: "Import rows",
});

export default defineProject("data-jobs", [ImportCommand]);
```

Register each pipeline exactly once, directly or through its command; mixed lists
such as `[SchemaBackedPipeline, ImportCommand]` keep their order. Duplicate pipeline
IDs fail, including a pipeline and its own command. Child pipelines are not
registered recursively. For [compiled documents](./declarative-pipelines.md), build
commands from `compiled.get(id)`. Pipeline IDs are the CLI and Studio IDs; `name`
only changes a label. The optional `cwd` (relative to the project file, default its
directory) sets the execution directory.

Automatic commands need Standard JSON Schema input metadata even when there are no
domain inputs. Schema-less pipelines still work in application code and in `list`,
`inspect`, `plan`, and `graph`; for `run` and Studio, add an options schema or an
explicit command (`params: {}` suffices).

### Selecting a project, pipeline, or file

- `tubeless.project.ts` in the current directory is the default; parent directories
  are not searched. Use `--project <path>` for another location.
- The default export must be a `defineProject` result and wins over named exports.
  Without one, the file must expose exactly one distinct project; several are
  ambiguous. An invalid default fails rather than falling back. This applies to
  every CLI command and Studio.
- Without `--project`, an argument naming an existing file is a file. Arguments with
  a `/`, a leading `.`, or an extension are always paths. Otherwise a bare name is a
  pipeline ID in the default project.
- For a directly loaded file, a single matching export is selected automatically;
  pass `--export Name` when there are several. A marked command wins over a pipeline.
  `--export` is ignored for project selections.

```sh
bunx tubeless list
bunx tubeless inspect import
bunx tubeless plan import --target normalized-import --explain
bunx tubeless graph import --markdown
bunx tubeless run import -- --source ../rows.txt --target normalized-import
bunx tubeless run ./scripts/import.ts -- --source rows.txt --target normalize
```

## List, inspect, plan, and graph

```sh
tubeless list [--project <path>] [--json]
tubeless inspect [options] <pipeline-id-or-file>
tubeless plan [options] <pipeline-id-or-file>
tubeless graph [options] <pipeline-id-or-file>
```

- `list` prints each pipeline's ID, name, and description. It evaluates the project
  file and its imports but never runs handlers. `--json` adds project metadata and
  resolved project and `cwd` paths.
- `inspect` shows name, description, targets, metadata, and the default structural
  plan (`--json` for machines).
- `plan` previews selection: `-t, --target <id>` (with prerequisites) or
  `-s, --step <id>` (exactly those steps), both repeatable but not combinable;
  `--dry-run` shows run/skip/preview per step; `--explain` says why each step is
  selected or omitted; `--json` emits the structured plan. It validates no business
  inputs and runs no handlers.
- `graph` writes Mermaid source: `-d, --direction <BT|LR|RL|TB|TD>` (default `TD`),
  `--descriptions`, `--metadata`, and `--markdown` (fenced block). In process, use
  `pipeline.toMermaid()`.
- `inspect` and `graph` filter steps with `--tag` (repeatable), `--owner`, and
  `--domain`; see [graph metadata](./graph-metadata.md). Filters never change
  execution.

Every command taking a pipeline accepts `-e, --export <name>` and
`-p, --project <path>`.

## Run

```sh
tubeless run [options] <pipeline-id-or-file> [-- <command-args...>]
```

Flags that choose the file or recording destination go before `--`. Flags for the
pipeline command go after it, including `--target`, `--step`, and `--dry-run`.

- `--json` writes the complete public `PipelineRun` report to stdout
- `--store <path>` appends run events to a local SQLite database
- `--trace <path>` writes NDJSON trace events to a file, or `-` for stdout

`--store` and `--trace` combine. With `--trace -`, the terminal reporter and command
result go to stderr so stdout stays valid NDJSON; it cannot be combined with `--json`.

`run` accepts a project pipeline ID or a file exporting a pipeline or
`definePipelineCommand`. An explicit command wins; otherwise one uniquely selected
schema-backed pipeline is wrapped automatically. Custom or unsupported input shapes
need an explicit command:

```sh
tubeless run --export ImportCommand ./scripts/import.ts -- --source rows.txt
tubeless run ./scripts/import.ts -- --help
```

Help lists the command's options, then the shared `Pipeline controls:`, with details
such as `[required]` or `[integer, min: 1, default: 1]`. Invalid arguments print each
error and the usage line, not the full help. Near-misses get a `Did you mean ...?`
hint without changing exit codes; see [typos](#typos-and-suggestions).

Start with [`automatic-cli.ts`](../examples/automatic-cli.ts); use
[`cli-job.ts`](../examples/cli-job.ts) only when inputs need custom mapping.

### JSON output

```sh
bunx tubeless run --json import -- --source rows.txt > run.json
```

Put `--json` before `--`. Stdout is one JSON document with the run ID, status,
timings, step reports, errors, `finalized`, and `value` when finalized. Reporter
output, logs, and command summaries go to stderr. Failed and cancelled runs still
print their report with their usual nonzero exit code; dry runs print the same record
with `dryRun: true`. Help, argument rejection, and setup failures print no report.

Finalized values must round-trip through JSON. `undefined`, `bigint`, `Map`, class
instances, cycles, or non-finite numbers produce an error on stderr, no JSON, and a
nonzero exit. Return plain JSON, using `null` for an empty result.

### Pipeline controls

Pass these after `--`, next to the command's own arguments:

| Flag                             | Effect                                                                   |
| -------------------------------- | ------------------------------------------------------------------------ |
| `--dry-run`                      | Uses each step's dry-run policy; unmarked steps still execute            |
| `--target <id>`                  | Runs a declared target and its required dependencies and failure gates   |
| `--step <id>`                    | Runs only the specified step IDs; it does not add prerequisites          |
| `--max-concurrency <number>`     | Limits simultaneous steps in this run; positive integer, defaults to `1` |
| `--continue-on-error`            | Continues independent work after failure; the run still fails            |
| `--cache use\|recompute\|bypass` | Overrides step output caching; see below                                 |

Repeat `--target` or `--step` for several IDs, but do not combine them. A dry run
still executes safe handlers and custom previews; use `tubeless plan` to inspect
selection without executing anything.

Fail-fast stops new dispatch and waits for active work; `--continue-on-error` keeps
eligible branches running. Child runs have separate limits: set `maxConcurrency` in
child `controls` to opt them in, and note that parent and fan-out limits multiply
([child composition](./child-pipeline-composition.md)).

`--cache` affects only steps that opted into caching, and propagates to children.
Omitting it respects step policies; `recompute` refreshes entries and `bypass` avoids
all cache I/O. Dry runs always bypass. See [step output caching](./step-output-cache.md).

### Application trace exporters

To send traces to your own destination, set `tracing` on the project:

```ts
export default defineProject("jobs", [ImportCommand], {
  tracing: {
    exporters: ({ pipelineId, cwd, signal }) => [
      createTelemetryExporter({ pipelineId, cwd, signal }),
    ],
    onExporterError: (error) => console.warn("Trace delivery failed", error),
  },
});
```

`createTelemetryExporter` is your code returning a `PipelineTraceExporter`; the
[tracing recipe](../examples/tracing.ts) has JSON and OpenTelemetry adapters. The
factory runs once per launch (never for help, planning, or rejected arguments),
composes with `--store`, `--trace`, and Studio's store, and should return fresh
exporters per call. A throwing factory rejects the launch. A failing exporter is
retired while others continue, and `onExporterError` receives the first failure per
run without failing the pipeline. Nested runs share the exporters; `runId` and
`parentRunId` identify each run. Calling `project.get(id).run()` directly uses the
caller's tracing context; combine destinations with `composeTraceExporters` from
`tubeless/tracing`. On [Cloudflare](./deploy-cloudflare.md#application-trace-exporters)
each export or flush is capped at five seconds.

## Live terminal output

Interactive terminals redraw a progress tree (finished-step counts, elapsed time,
`waiting on ...`, skip reasons). Redirected or non-interactive output gets plain
append-only logs. The reporter honors `NO_COLOR`, `FORCE_COLOR`, `TERM`, and `CI`.
On terminals at least 120 columns by 8 rows, a **Logs** pane beside the tree shows
recent `context.log` lines, and a failing step's last 50 lines print under the final
tree. Disable it per command:

```ts
definePipelineCommand(pipeline, { reporter: { logPane: "off" } }); // Default: "auto"
```

Only `context.log` appears in the pane; forward subprocess output to it. Use
`--trace` or `--store` for a complete recording. Child pipelines render as indented
steps, with inner progress bars when the child calls `context.reportProgress`; see
[child composition](./child-pipeline-composition.md) and
[fan-out progress](../examples/fan-out-progress.ts). Try `bun examples/live-tui.ts`.

## History

```sh
tubeless history [options] [run-id]
```

- `--store <path>` selects the SQLite database (default `.tubeless/runs.sqlite`)
- `--trace <path>` reads a finished NDJSON trace instead; cannot combine with `--store`
- `--pipeline <id>` filters by exact recorded pipeline ID
- `--json` emits the run list, or one run when `run-id` is given
- `--events` emits raw store events as NDJSON, scoped to the requested run
- `--transcript <path>` attaches a finished agent transcript to the selected run
- `--import-transcript <path>` copies a finished transcript into existing SQLite history
- `--clear --yes` deletes all events and stored transcripts and compacts the store;
  there is no interactive prompt

```sh
bunx tubeless history --pipeline import
bunx tubeless history --json <run-id>
bunx tubeless history --trace run.ndjson
```

- A run ID may be a unique prefix of at least four characters; an ambiguous prefix
  lists the matches and exits `1`, as does an unknown run. A pipeline with no runs
  returns an empty list (exit `0`).
- History reads recorded data without loading a project or command module. A run's
  detail shows steps, logs, errors, and for agent runs the turn, call, and token-usage
  structure (see [agent history](./agents.md#inspection-and-recordings)). Transcripts
  are described in [transcript inspection](./agents.md#save-and-inspect-a-transcript).
- A missing store exits `2`, as does one with a pending `-wal` or `-journal` file,
  multiple hard links, or an unsupported format. Older schemas (1 through 4) can be
  read; writing commands refuse them until [`tubeless upgrade`](#upgrade).
- NDJSON traces are opened read-only and validated. Artifacts over 64 MiB, event lines
  over 1 MiB, and traces over 100,000 events are refused; diagnostics name the line
  and field without echoing contents.
- Stores and traces can contain sensitive logs, errors, and payloads. Open only
  files you trust.

## Upgrade

```sh
bunx tubeless upgrade --yes --store .tubeless/runs.sqlite
```

Rewrites an older SQLite store (default `.tubeless/runs.sqlite`) to the current
schema in one commit that cannot be undone. Without `--yes` it exits `1` and changes
nothing; a missing store exits `2`; a current store exits `0` untouched. Run it before
any unattended `tubeless run --store` or `tubeless ui`, which refuse an older store
rather than upgrading it mid-job.

## Init

```sh
tubeless init [project]
tubeless init cloudflare [-p, --project <path>]
```

`tubeless init` writes `tubeless.project.ts` and `pipelines/import.ts` (identical to
[`examples/starter/`](../examples/starter/tubeless.project.ts)) in the current
directory and leaves `package.json` alone:

```sh
bun add tubeless # If it is not installed yet.
bunx tubeless list
bunx tubeless plan import
bunx tubeless run import -- --lines " Alpha " --lines Beta
```

`tubeless init cloudflare` scaffolds `cloudflare/worker.ts`, `cloudflare.config.ts`
and `vite.config.ts` for an existing project and prints the install step; see the
[Cloudflare guide](./deploy-cloudflare.md). `--project` selects the project file and
is accepted only by deployment targets.

`init` never overwrites: if any target file exists it names the conflicts and writes
nothing. An unknown or repeated target is a usage error.

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

SIGINT and SIGTERM are forwarded through the command context. Help exits `0`.

## Typos and suggestions

Unknown commands, flags, choice values, pipeline IDs, plan targets and steps, and
history run IDs get a `Did you mean ...?` hint:

```text
$ tubeless run import -- --sourc rows.txt
Error: Unknown option: --sourc. Did you mean --source?
```

## Shell completion

```sh
eval "$(tubeless completion bash)"     # ~/.bashrc
source <(tubeless completion zsh)      # ~/.zshrc, after compinit
tubeless completion fish | source      # ~/.config/fish/config.fish
```

Completion covers commands, flags, project pipeline IDs, `plan` targets and steps,
and the flags of the pipeline command after `tubeless run <id> --`. Project files are
loaded to read IDs, but no handlers run.

## Prompt a workspace agent

`tubeless agent` opens a terminal prompt loop around the built-in workspace agent,
with `read`, `write`, `edit`, `bash`, `list`, and `search` tools that run with your
host permissions. Prompts share one in-memory conversation and show the same live
reporter as `tubeless run`; see [agents](./agents.md#default-model-backed-agent) for
tool contracts.

```sh
export OPENAI_API_KEY # Child processes only see exported variables.
tubeless agent --model gpt-5.4-mini
tubeless agent --prompt 'Find and fix the failing test, then verify it'
```

In the REPL, `/model [name]` shows or sets the next model, `/clear` starts a fresh
conversation, `/help` lists commands, and `/quit` exits. Tab completes slash
commands. Ctrl-C cancels active work and returns to the prompt (at an idle prompt it
exits). A failed or cancelled prompt keeps the last completed conversation. Each
prompt has fresh execution budgets.

Piped input runs one task per line; `--prompt` runs one task and exits. The exit code
is the last task's: `0`, `6` for failure, `7` for cancellation.

Flags for the built-in agent (run `tubeless agent --help` for all):

- `--provider <name>` (`openai` default, or `anthropic`) and `--model <name>`
  (overrides `OPENAI_MODEL`/`ANTHROPIC_MODEL`)
- `--env-file <path>`, `--instructions <text>`, `--tools read,list,search`, and
  `--max-turns`, `--max-calls`, `--max-concurrency`
- `--codemode` ([code mode](./agents.md#code-mode)) and `--stream`
  ([streaming](./agents.md#stream-public-assistant-text))
- `--no-graph` hides pipeline reporting, keeping logs and answers
- `--model-module <path>` supplies a provider registry or model factory (below)

Credentials: export `OPENAI_API_KEY`, or `ANTHROPIC_API_KEY` with `--provider anthropic`
(`ANTHROPIC_AUTH_TOKEN` works as a bearer token when no API key is set). The agent
checks that a credential is present before opening the REPL. Model names never
select a provider; start a new session to change providers.

`--env-file` (a dotenv file, relative to the workspace, kept out of version control)
supports quotes, comments, and `export` prefixes, with no variable expansion.
Existing process environment values win over the file, and file values reach the
model factory without touching `process.env`. `OPENAI_BASE_URL` and
`ANTHROPIC_BASE_URL` (an API root without `/v1`) select the endpoint.

A 401 means the credential reached the provider and was rejected. Tubeless prints
only known error codes and safe advice, never raw provider messages. Restart after
changing credentials, and remove a stale exported key that would override `--env-file`.

### Record agent runs

Recording is off by default. `--store <path>` appends each prompt as a
`tubeless-agent` run (turns and tool calls as children) and `--trace <path>` writes
NDJSON, both in the same formats as `tubeless run`. `--trace -` is rejected, and
`--store` and `--trace` cannot name the same file.

```sh
tubeless agent --model gpt-5.4-mini --store .tubeless/runs.sqlite
tubeless history --pipeline tubeless-agent
```

Logs and tool activity can contain workspace content; keep recordings as private as
the workspace. For the built-in agent, add `--capture-transcript` (requires `--store`)
to save prompts, public assistant text, decisions, and tool inputs and results in
SQLite, within the usual transcript bounds and without a custom redactor. For custom
redaction, use an application-defined transcript sink. The
[scripted model example](../examples/agent-transcript-model.ts) runs credential-free:

```sh
tubeless agent --model-module ./examples/agent-transcript-model.ts --prompt "List the current directory." --store .tubeless/runs.sqlite --capture-transcript
tubeless history --store .tubeless/runs.sqlite <agent-run-id>
tubeless ui --store .tubeless/runs.sqlite
```

### Select a defined agent

Pass a project entry ID or module file to chat with an existing `defineAgent` agent.
Resolution matches `tubeless run`: the current directory's `tubeless.project.ts`,
`--project`, or `--export` for a file.

```sh
tubeless agent coding-agent
tubeless agent coding-agent --project ./jobs/tubeless.project.ts
tubeless agent ./agents/support.ts --export SupportAgent
bun run tubeless -- agent ./examples/agent-chat.ts # Credential-free, from this checkout
```

The session keeps the agent's model, tools, child pipelines, MCP tools, and
environment; `--store` and `--trace` record under the agent's own ID.

The agent must use `defineAgent` with default schemas (`{ task: string }` in,
`{ answer: string }` out). Use `tubeless run` for typed agents, custom result schemas,
or `defineAgentLoop`; `createAgentSession` supports those in application code.

Selected agents own their configuration, so the CLI rejects `--model`, `--provider`,
`--model-module`, `--env-file`, `--instructions`, `--tools`, `--codemode`, `--stream`,
and the `--max-*` flags instead of ignoring them. Export the agent's credentials to
the process. `--prompt`, `--no-graph`, `--store`, and `--trace` work in both modes.

### Configure named providers

A provider name identifies a configuration, not an API format. Default-export a
registry (typed with `AgentProvider` from `tubeless/cli`) from a trusted local module:

```sh
export BASETEN_API_KEY
tubeless agent --model-module ./examples/agent-providers.ts --provider baseten
```

See the [compiled registry](../examples/agent-providers.ts). Each entry has:

- `model`: the default model; `modelEnv` overrides it; `--model` overrides both.
- `credentialEnv`: credential variables in priority order. The CLI requires a
  nonblank value before opening the REPL; omit it for other auth methods.
- `createModel({ model, signal, env })`: runs once per prompt, with scoped
  `--env-file` values in `env`. It owns authentication and must read that `env`.

An explicit model module replaces the built-in registry, and an unknown `--provider`
fails rather than falling back to a public service. For OpenAI-compatible endpoints
see [compatible APIs](./agents.md#compatible-apis).

### Supply a single model factory

Without `--provider`, `--model-module ./model.ts` accepts a default-exported factory
taking `{ model, signal, env, text? }` and returning an `AgentModel`, sync or async.
Tubeless calls it per task. Pass `signal` into async setup, and forward `text` to
`openaiModel` or `anthropicModel` to support `--stream`. A custom model must append
the new user task on `context.turn === 1` and return a complete plain-data
conversation to retain it. See [`agent-repl-model.ts`](../examples/agent-repl-model.ts).

## Named remotes

Use the same commands for a **Tubeless Cloud** workspace and a **self-hosted
Cloudflare** deployment. Select a provider when prompted.

```sh
bunx tubeless remote connect
bunx tubeless remote connect https://jobs.example.com --name production
bunx tubeless remote create
bunx tubeless remote list
bunx tubeless remote run ingest --remote production --input-file input.json
```

`connect` discovers Tubeless Cloud workspaces after sign-in or Tubeless
Workers in a selected Cloudflare account. A Studio URL also works for existing
self-hosted deployments with the execution API, with Access credentials for that
URL and no Cloudflare account management access needed.

`create` reuses Tubeless Cloud sign-in and connects a workspace. Finish creating a
workspace, connecting a GitHub repository, and loading pipelines in the dashboard
when prompted. For Cloudflare, the wizard deploys the current project or initializes
a starter project, configures Access for the selected email, and checks the
deployed execution API before saving it. See the [Cloudflare wizard](./deploy-cloudflare.md#set-up-a-named-remote).

Profiles live in `~/.config/tubeless/remotes/` (or under `XDG_CONFIG_HOME` when
set). Each profile is a JSON file containing the remote destination and its
authentication mode. Credentials stay in their provider's login store or the
environment. Use `--remote <name>` to select a profile. Tubeless selects the sole
saved remote automatically, and requires a choice when several are configured.
For self-hosted execution, `--host <origin>` still works directly.

Foreground runs and `remote status <run-id> --follow` stream logs and progress
from Tubeless Cloud. Use `--poll` to follow on Cloud deployments without streaming
support. For a saved Cloud remote, `remote status <run-id>` returns the same
snapshot as `cloud inspect`, and `remote cancel <run-id>` returns the same receipt
as `cloud cancel`. Both use the host and workspace from the profile. With
`--follow --json`, status returns the log summary described below.

## Self-hosted Cloudflare executions

Use `tubeless remote run <command-id> --host <origin>` to submit to a self-hosted
Cloudflare deployment. `--detach` returns an execution ID after durable admission.
`remote status <id>` reads the current state, `status --follow` waits, and
`remote cancel <id>` records a cancellation request. Pass `--json` for a single
receipt or status object. Following exits with `0` for success, `6` for failure
or unknown outcome, and `7` for cancellation or a local interruption.
See [self-hosted authentication and status](./deploy-cloudflare.md#submit-and-follow-from-the-cli).

`tubeless remote runner --host <origin> --deployment-id <id> [--project <file>]`
starts an enrolled local Bun runner. The project defaults to `tubeless.project.ts`
and must supply definitions from the same deployment revision. Use the runner's
dedicated Access service credential. See [runner placement](./deploy-cloudflare.md#place-work-on-a-local-bun-runner).

## Tubeless Cloud

To use the Cloud service, create or join a workspace, install the GitHub App,
and connect a repository in the [Cloud dashboard](https://cloud.tubeless.io).
Manage connections, pipeline loading, secrets, schedules, and billing there.

```sh
tubeless auth login
tubeless cloud list
tubeless cloud run orders-sync --input-file input.json
tubeless cloud run orders-sync --detach --json
tubeless cloud inspect <run-id> --json
tubeless cloud follow <run-id> --workspace <workspace-id> --json
tubeless cloud logs <run-id> --follow
tubeless auth logout
```

Cloud service commands work from any directory and use the repository and
pipeline configuration stored in Cloud. They accept
`--workspace <id>` (auto-selected when the session has one workspace) and
`--host <origin>` (default `https://cloud.tubeless.io`; HTTPS only, except loopback
development). Credentials are isolated by full origin.

### Authentication

- `auth login` approves a device in the browser (`--no-browser` prints the URL and
  code). Sessions last seven days and are revocable. Tokens live in the OS credential
  store through Bun's `Bun.secrets`; if none is available, login reports a storage
  failure and never falls back to plaintext files.
- For headless use, set `TUBELESS_TOKEN` to a session or a Cloud automation token. It
  overrides stored credentials and is never saved or printed. Automation tokens
  require `--workspace` and are issued, scoped, and revoked in the dashboard.
  `auth status` is for interactive sessions. Use `cloud list` or `cloud inspect` to check
  automation access.
- `auth logout` revokes a stored session; remove an environment token yourself.

### Run a pipeline

`cloud list` shows each pipeline's slug, name, Cloud ID, availability, and deployed
commit. `cloud run` accepts an exact name or a listed slug. Slugs derive from the
current name, so renaming changes them. If names or slugs collide, use
`cloud run --id <cloud-pipeline-id>`, which cannot be combined with a name or slug.
Owners, admins and members can run; viewers can list and read logs.

A run-only automation grant should skip listing and detach:

```sh
# Inject TUBELESS_TOKEN through your CI secret store.
tubeless cloud run --id <cloud-pipeline-id> --workspace <workspace-id> --detach --json
```

Listing, name resolution, inspection, logs, and foreground waiting need read scope.
Submission needs run scope. If admission succeeds but following is denied, use the
run ID from the diagnostic to recover the result with a read credential.

**Source.** Without a selector, Cloud runs the HEAD of the pipeline's configured
branch; the CLI never inspects your checkout. The admitted commit SHA is printed with
the run ID and returned as JSON `commit`. `--ref` selects a GitHub branch, tag, full
SHA, or unambiguous short SHA (use `heads/<name>` or `tags/<name>` to disambiguate);
Cloud resolves it once and pins all reads to that commit. A ref run requires an
explicitly empty pipeline secret scope and does not create a promotable release
candidate.

```sh
tubeless cloud run checks --ref feature/orders
```

`--source <json|@path|->` takes an advanced selector (inline JSON, a file, or stdin;
at most 64 KB) and excludes `--ref`. Two kinds exist, with full 40-character hex SHAs:

```json
{ "kind": "main", "commit": "0123456789abcdef0123456789abcdef01234567" }
```

```json
{ "kind": "pull_request", "number": 19, "headSha": "...", "baseSha": "...", "mergeSha": "..." }
```

Unknown fields and incomplete selectors are rejected locally, and a rejected selector
never falls back to the latest revision. Immutable sources require an explicitly empty
secret scope. A selector cannot choose commands, images, secrets, or another
repository. Only one of `--input-file` and `--source` may read stdin.

**Input.** `--input-file <path|->` supplies a JSON object of at most 64 KB (default
`{}`) with at most 128 nesting levels. Arrays, scalars, `null`, malformed JSON, and
overflowing numbers fail before admission. There is no local schema inference.

**Idempotency.** Each invocation uses one idempotency key for its transport retries.
If admission stays uncertain, the diagnostic prints the key, workspace and pipeline
ID. Replay it from a new invocation with identical host, workspace, principal,
pipeline, input and source:

```sh
tubeless cloud run --id <cloud-pipeline-id> --workspace <workspace-id> \
  --input-file input.json --source @source-selector.json \
  --idempotency-key ci.check.123 --detach --json
```

Keys are 1-200 letters, digits, `.`, `_`, `:` or `-`. Changed intent under the same
key conflicts, and a replay returns the original admission receipt, not later
status. Never reuse an uncertain key for new work, and never start a fresh run to
retry an uncertain admission.

### Inspect or cancel a run

```sh
tubeless cloud inspect <run-id> --workspace <workspace-id> --json
tubeless cloud cancel <run-id> --workspace <workspace-id> --json
```

`cloud inspect` makes a single read and returns the retained run at its current
status. JSON includes the admitted source identity when available, steps, retained
logs, result, structured errors, diagnostics and artifact metadata. Optional fields
and diagnostic omission or completeness markers follow the Cloud run projection.
A successful read exits `0` at any run status. Use `cloud follow` to wait for a
terminal outcome and get the corresponding execution exit code.

`cloud cancel` sends one cancellation request. Interactive sessions need write
access to the workspace. Automation tokens need both `cancel` and `read` scopes
and access to the pipeline. Cloud applies its existing restrictions on cancelling
deployment runs with an automation token.

A successful response exits `0` and returns `{runId, status, alreadyFinished}`.
`alreadyFinished: true` means the run was terminal before this request. Otherwise
the request was accepted and `status` reports the state Cloud observed. Settlement
can lag, or the run can finish while cancellation is in progress. If the response
is lost or unusable, inspect the run under the same host and workspace before
deciding whether to issue another request. The CLI sends a single POST per
invocation.

### Follow and read results

Foreground `cloud run`, `cloud follow <run-id>`, and `cloud logs <run-id> --follow`
stream progress and output from the same Cloud run. `waiting` keeps the
observation open while the run waits for human input in the dashboard. The CLI
reconnects from the last processed cursor and reads the complete retained run
once after the terminal event. Ctrl-C stops local observation and leaves the Cloud
run active. Use `cloud cancel <run-id>` to request cancellation explicitly.

Use `--detach --json` to return the admission and read its `.id` in scripts. If
observation stops after admission, attach to that ID under the same host,
workspace, and principal. Supply the last cursor when available.

```sh
tubeless cloud follow <run-id> --host <origin> --workspace <workspace-id> \
  --cursor <cursor> --json
```

With `--json`, a stopped observation writes a `cloud_follow_error` JSON line to
stderr with `error.code` and `recovery` fields `host`, `workspaceId`, `runId`, and
`cursor` when available. Each cursor is scoped to its workspace and run, expires
after 24 hours, and requires a separately authorized credential. After
`cursor_expired`, omit `--cursor` to start from the available retained output.
`unauthenticated` and `authorization_lost` indicate lost observation authority.
`transport_error` indicates a lost connection after bounded retries and
`observation_timeout` indicates the request deadline elapsed. Cloud's normal
stream rotation reconnects automatically.

Source truncation and gaps in retained output produce `cloud_follow_gap` JSON
lines on stderr. The run can still finish successfully. `cloud logs` without
`--follow` reads the retained snapshot, which has at most 400 log entries.
Retention follows the workspace plan.

Streaming requires Cloud to advertise run following v1 over NDJSON. For older
services, use `cloud follow <run-id> --poll` or `cloud logs <run-id> --follow --poll`.
`cloud run --poll` opts into polling for a new submission. Polling reads retained
status and logs every two seconds while the run is active and takes no cursor.
If foreground admission succeeded before the capability error, use the returned
run ID to attach.

`--json` writes one value to stdout on a terminal result and leaves stdout empty
when observation fails. Foreground `cloud run` and `cloud follow` return the full
terminal run including retained structured diagnostics. `logs --follow --json`
keeps its `{id, pipelineId, status, logs}` shape. Human output neutralizes terminal
controls in remote text. JSON retains remote data with the active bearer redacted
from output.

Cloud exit codes are `0` for a successful operation, `1` for usage,
`2` for missing runs, credentials, workspace selection, transport or observation
errors, `4` for invalid JSON or requests, `6` for quota or rate limits, rejected
admission or failed execution, and `7` for a followed cancellation or local
interruption. A remotely interrupted run keeps
`status: "failed"` and its diagnostic. In JSON mode, stderr also reports
`{"type":"cloud_follow_terminal","outcome":"interrupted"}`.

### Reproduce a Node check locally

Run `tubeless cloud reproduce --execute <manifest.json>` with Git, Node 24
and Bun 1.4.4 on PATH. It uses the saved manifest and your Git permissions
without Cloud login. It verifies the original commit, tree, lockfile and plan
in a temporary checkout, then runs the check and emits JSON with native
outcomes and normalized reports. See [reproduction manifests](./reproduction-manifest.md)
for the supported scope and what the execution flag authorizes.
