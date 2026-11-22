# Source modules

Maintainer map: which directory owns what, which directions imports may point,
and which of those rules tests enforce. File names show what a file does; this
document records only ownership and boundaries.

The runtime is dependency-free with focused public entrypoints. `tubeless` owns
pipeline execution, `tubeless/cli` terminal command declarations, and
`tubeless/project` typed pipeline collections and declarative compilation. Studio
and storage are optional integrations behind the bundled executable; their
implementation modules are not public subpaths. Keep tests beside their source.

## Directories

| Directory     | Owns                                                                                                           |
| ------------- | -------------------------------------------------------------------------------------------------------------- |
| `core/`       | Pipeline definitions, graph planning, execution, lifecycle and progress                                        |
| `agent/`      | In-process decision loop, tools, model-backed agents, provider adapters, MCP, code mode, durable checkpoints   |
| `tracing/`    | Trace contracts, internal emission, exporter composition, pure agent telemetry and transcript record schemas   |
| `utilities/`  | Domain-independent cancellation, bounded body reading, batching, retry, rate limits, checkpoint store contract |
| `cli/`        | Argument parsing, command declarations and pipeline adaptation                                                 |
| `reporter/`   | Terminal reporting and live ticker rendering                                                                   |
| `render/`     | Plan and error formatting                                                                                      |
| `run-store/`  | Event reader/store contracts, projection, SQLite and NDJSON adapters                                           |
| `studio/`     | `browser/` (app, components, graph), `server/` (handler, API, Node adapters), `shared/` (protocol, schemas)    |
| `project/`    | Typed pipeline projects and parsed pipeline document compilation                                               |
| `hosting/`    | Platform-neutral deployment kit: project commands, hosted execution, launch admission, collector ingest        |
| `cloudflare/` | Cloudflare deploy target and the `tubeless/cloudflare`, `/cache` and `/transcript` entries                     |
| `workbench/`  | Module loading, executable commands, Cloud client, agent REPL, adapter wiring                                  |
| `check/`      | Optional Node check recipe execution over ordinary pipeline steps                                              |
| `node/`       | Optional filesystem, path, environment, checkpoint and Node worker-thread helpers                              |
| `testing/`    | Test runtime and executable-example integration tests                                                          |

## Dependency direction

`core/pipeline-entry.test.ts` reads the emitted `dist/` runtime graph, including
re-exports and lazy imports, and fails on any edge outside this table.

| Module                 | May import                                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------------- |
| `tracing`, `utilities` | nothing (tracing shares type-only pipeline contracts with core)                             |
| `core`                 | `tracing`, `utilities`                                                                      |
| `check`                | `core`, `node`, `utilities`                                                                 |
| `node`                 | `utilities`                                                                                 |
| `agent`                | `core`, `tracing`, `utilities`                                                              |
| `render`               | `core`                                                                                      |
| `reporter`             | `core`, `utilities`                                                                         |
| `project`              | `core`, `utilities`                                                                         |
| `testing`              | `core`, `tracing`, `utilities`                                                              |
| `run-store`            | `core`, `tracing`, `utilities`                                                              |
| `studio`               | `run-store`, `tracing`, `utilities`                                                         |
| `cli`                  | `core`, `node`, `reporter`, `tracing`, `utilities`                                          |
| `hosting`              | `cli`, `core`, `project`, `render`, `run-store`, `studio`, `tracing`, `utilities`           |
| `cloudflare`           | `agent`, `cli`, `core`, `hosting`, `project`, `run-store`, `studio`, `tracing`, `utilities` |
| `workbench`            | everything above except `check`, `node`, `testing` and `cloudflare`                         |

The same table is enforced on source files by per-directory `no-restricted-imports`
overrides in `.oxlintrc.json`, so a forbidden import fails lint before the build. Type-only
imports are allowed, and test files (`*.test.ts`, `*.test-support.ts`) are exempt. The
overrides also forbid Node built-ins in `tracing`, `hosting`, `project`, `render` and
`cloudflare`, and `cloudflare:` imports everywhere except `cloudflare/cloudflare.ts`.
Change the table, the test allowlist and these overrides together.

Runtime import cycles are rejected (`import/no-cycle` in lint, plus the graph test). Computed
imports are allowed only in the module-loader owners listed in the test. Keep allowed lists narrow when adding
modules; avoid new cross-module contracts unless a consumer needs them. Type-only
imports may share contracts without loading implementations.

### Closure checks

The test also walks these entrypoints and fails if they reach anything outside
the stated set. Add a module to an allowlist only when the dependency is
intentional.

- **Root entrypoint** (`core/pipeline.js`): only `core`, `utilities` and the listed
  tracing internals. No exporters, storage, UI, command parsing or presentation.
- **Core**: only `core/lifecycle.ts` imports the internal trace emitter. Execution
  errors (`pipeline-execution-error.ts`) import neither the executor nor run state.
- **Generic agent entrypoint**: no provider, `openai`, `anthropic` or `mcp` modules.
  Provider and MCP adapters are separate optional entrypoints that produce ordinary
  tools and models.
- **CLI entrypoint**: only `cli`, `core`, `node`, `reporter`, `tracing`, `utilities`,
  including lazy imports. It never reaches workbench, storage or Studio.
- **Project entrypoint**: only `project`, `core`, `tracing`, `utilities`. Commands
  are referenced type-only. `project-registry.ts` reaches only `project-document.ts`.
- **Studio request pipeline** (`handler`, `page`, `api`): no Node built-ins or
  platform modules. Node HTTP, listener and client-script loading stay in their
  adapter files.
- **History and API routes**: no pipeline execution, concrete storage adapters or
  page assets. Studio decodes at the transport boundary rather than trusting shapes.
- **Studio graph scene** (`graph/scene.ts`): pure layout; no UI, transport, server
  or external runtime.
- **Ticker worker**: independent of reporter orchestration and worker creation.
- **Studio launch execution**: no command entrypoints, HTTP server or concrete storage.
- **Hosting kit**: no `workbench`, `cloudflare`, concrete SQLite/NDJSON stores,
  Node HTTP listener, or `node:` imports.
- **Collector worker entrypoints**: no CLI startup, Cloudflare, or concrete storage.
- **Cloudflare**: only `cloudflare/cloudflare.ts` imports `cloudflare:workers`, and its
  declarations stay structural. `cloudflare-cache.ts` must load in Node, so project
  modules that use it keep working outside workerd.

`scripts/module-references.ts` reads JavaScript and declaration syntax for these
graphs, API dependency hashes and the inline-bundle guard; literal text creates no
dependency. `make check` builds before running these tests.

## Ownership notes

Only boundaries that are not obvious from names are listed.

### Core

- `createSteps` and its typed overloads live in `pipeline-steps.ts`; definition types
  in `pipeline-step-types.ts`; erased runtime builders in `pipeline-step-builders.ts`.
- `pipeline-definition-validation.ts` produces validated order, targets, cache plans
  and finalizer metadata once; graph compilation consumes that order instead of
  sorting again.
- `pipeline-execute.ts` coordinates a run; `lifecycle.ts` owns hooks, trace creation,
  scoped loggers and flushing; `pipeline-run-state.ts` owns state transitions and
  terminal reports; `pipeline-cache.ts` owns cache keys and policy around handler
  execution and imports no concrete store or codec eagerly.
- `pipeline-output-observer.ts` captures detached raw bytes before schema validation
  and returns a prepared output whose commit waits for host persistence. The cache
  passes that publication through while storing raw handler results only. Encoded
  bytes never enter run state or lifecycle metadata; run observation metadata is
  shared only within its configured invocation.
- `core/execution-journal.ts` owns host journal acknowledgements, logical paths,
  compatibility bindings, per-step recovery and shared infrastructure failure state.
  Scheduling delegates the step protocol; handler failures stay outside the host
  acknowledgement boundary. It imports no
  storage or agent runtime. Child composition extends its scope; native agents
  consume a structural byte-store handoff and suppress the outer journal.
- `run-controls.ts` snapshots graph controls for direct runs, child runs and
  static iteration identities. Its property order preserves durable definition
  hashes; do not reorder without a definition-identity version bump. Direct runs
  use `prepareRunControls` to admit and snapshot output observers and supplied
  entries separately, returning diagnostics to the planner; child controls reject
  both. Only the planner constructs failed plans. Supplied raw values share the test override validation
  path without observation, cache access, or handler execution.
- `PipelineChildRunControls` is the shared authored-control contract for child
  constructors, project adapters, and decoded plan metadata. Keep invocation-only
  capabilities excluded there rather than adding exclusions at each consumer.
- `iteration.ts` invokes the existing child runner; it neither reschedules the
  parent DAG nor owns a separate lifecycle.
- `waitForInput` is an ordinary step with an application-owned read callback; core
  has no terminal or UI dependency. Reader errors retain handler provenance
  independently of leaf permit admission.
- `child-execution.ts` owns inherited child runtime context; invocation-specific hooks
  and identities stay with callers. Core carries the agent's opaque execution scope
  through child execution; orchestration steps hold no leaf permit.

### Tracing

- `tracing-constants.ts` owns output-source vocabulary and its derived type.
  `tracing-schema.ts` owns the shared decoder used by trace and stored-run schemas.
  Keep provenance fields on that contract instead of repeating literal unions.

### Agent

- `compile-agent.ts` compiles both custom-decision and model-backed agents through
  one turn pipeline. `model-agent.ts` owns `defineAgent`; `agent-session.ts` owns
  `createAgentSession`. `chat-session.ts` is a versioned-symbol bridge so the workbench
  can start default task/answer sessions from separately installed copies.
- `execution-scope.ts` owns ancestor budgets and leaf admission; `invocation.ts`,
  `checkpoint-session.ts`, `checkpoint-format.ts` and `checkpoint-calls.ts` own
  recovery. Callers cannot mutate the journal. Storage and codecs are separate
  contracts; traces stay best-effort and independent of recovery.
- Handler tools validate arguments before dispatch and run as private one-step
  pipelines. `default-tool-names.ts` is the pure builtin inventory shared with CLI
  setup, and `default-tools.ts` must provide exactly those names.
- `transcript.ts` owns opt-in content capture and redaction. Sinks are
  application-owned with no storage or trace dependency; entering a child agent
  resets capture unless it opts in.
- Providers (`openai.ts`, `anthropic.ts`) share `provider-*.ts` helpers for bounded
  HTTP, SSE, schema and byte budgets. `agent-errors.ts` stays independent of state
  hashing so provider imports need no Node modules.
- `mcp.ts` adapts MCP servers into ordinary `defineTool` capabilities; the agent
  runtime has no MCP concepts. Transports consume pure wire contracts from
  `mcp-protocol.ts`.
- Code mode: `codemode.ts` dispatches script calls through the normal prepared-call
  and child-execution path. Executors run one script and stop on abort;
  `codemode-node.ts` (worker thread plus `node:vm`) loads lazily.
  `cloudflare/cloudflare-codemode.ts` supplies the Worker Loader executor.
- `tubeless/agent/node` supplies local environment, SQLite checkpoint and NDJSON
  transcript adapters.

### Project

- `project-document.ts` validates document structure and path-aware errors only.
  `project-registry.ts` validates named handlers, schemas and adapters without
  invoking them. `project-step-graph.ts` builds one pipeline; `project-compiler.ts`
  owns document-wide composition, shared children and cycle detection. The compiler
  performs no parsing or I/O.
- Project tracing configuration references only trace contract types; workbench and
  hosting create the launch's exporters.

### Hosting and Cloudflare

- Hosting composes CLI command adapters, project, Studio and storage contracts for
  deployment targets. Targets own dispatch deduplication, recovery scheduling,
  drivers and event-store schema initialization.
- `run.ts` owns execution admission, ordered batching and deadlines; `run-coordinator.ts`
  owns launch validation and acknowledgements through a `HostedRunDriver`.
  `launch-admission.ts` owns idempotent submission policy; the SQLite adapters
  commit history and launch mutations in one transaction. `launch-metadata*.ts` owns
  opt-in input capture (history, deletable without deleting admission keys; schema in
  `studio/shared/launch-metadata.ts`), and `admitted-studio-launcher.ts` bridges
  durable admission to browser start acknowledgements. `execution-store-sqlite.ts`
  persists pending deliveries, cancellation intent, and terminal outcomes under the
  launch ID. Verified Access actors reach Studio via private Worker RPC.
- The collector (`collector-*`, `attempt-*`) is internal. Claim uncertainty never
  authorizes execution, and delivery failure never declares termination.
- Cloudflare composes hosting, Studio and storage inside Durable Objects.
  `cloudflare-run-contract.ts` holds the deadline and host-failure vocabulary
  without loading execution. `cloudflare-execution-api.ts` serves the authenticated
  execution contract separately from the Studio browser protocol.

### Workbench

- `workbench-command-specs.ts` is the single command inventory; dispatch, root help,
  completion and subcommand parsing derive from it.
- Normalize project pipelines and direct files into workbench registrations at
  loading boundaries; commands and Studio use the lazy loaders rather than
  branching on source kind.
- `workbench-launcher.ts` is the package `bin` target and picks the runtime (Bun);
  `workbench-bin.ts` is the direct entry and reserves JSON stdout before loading
  application modules.
- `workbench/cloud/` never imports selected pipeline files and stays outside public
  runtime entrypoints. `workbench/agent/` holds the REPL, provider resolution and
  prompt/session sequencing over `createAgentSession`.
- Studio launcher and launch sessions receive only a trace exporter; they cannot
  query, clear or close the store. Stop admission, drain executions, then close storage.

### Reporter

`interactive-reporter.ts` owns lifecycle and redraw; `live-ticker.ts` owns worker
startup, fallback and shutdown; `live-ticker-frame.ts` is pure rendering through an
injected writer; `live-ticker-protocol.ts` owns worker messages and the shared-memory
output lock. Only a worker exit permits clearing an abandoned lock.

### History and Studio

- `run-store/run-store.ts` defines storage contracts and coordinates incremental
  projection. `run-projection.ts`, `definition-projection.ts` and `agent-projection.ts`
  own their projections; none imports agent execution or a storage adapter.
- `run-store-reader.ts` owns cursor pagination for CLI history and Studio. Consumers
  control backpressure and close the reader.
- `run-store/ndjson-artifact.ts` validates finished files for trace and transcript
  readers; `agent-transcript-sql.ts` shares schema and page semantics between SQLite
  and Durable Objects, whose adapters own transactions.
- `studio/server/state.ts` serializes reads and history clearing; reset caches only
  after the maintenance adapter succeeds. `handler.ts` fixes request order:
  authentication, trusted host, Origin on mutations, mount, health, page, then API.
- `studio/shared/schema.ts` defines the browser protocol and reuses pure trace
  schemas; successful reply shapes belong there.
- Studio server and browser code is separated by directory; the browser never loads
  server or transport code from graph construction.

## Layout conventions

Use directories for feature ownership instead of repeating it in file names, with
short role names (`command.ts`, `session.ts`, `transport.ts`) inside them. Import
implementations directly; do not add barrels for internal folders. Public package
subpaths are the API boundary.

## Adding or moving modules

- New module: pick the directory by the dependency table; extend an allowlist in
  `pipeline-entry.test.ts` only when the new edge is intended.
- New public entrypoint: add the package export and run `bun run api:generate`.
- Moving files: update export and `bin` targets, lint overrides, Knip entries,
  worker URLs and Studio generation paths. Keep public subpath names stable.
  Declaration hashes include internal paths, so regenerate the API inventory with
  `bun run api:generate`, and the browser client with `bun run build` when its
  source or generated location changes.
- Run `make check` after changes.
