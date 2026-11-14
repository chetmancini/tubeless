# Source modules

Keep one dependency-free runtime with focused public entrypoints. `tubeless`
owns pipeline execution; `tubeless/cli` owns terminal command declarations;
`tubeless/project` owns typed
pipeline collections and declarative compilation.
Each public API has one entrypoint. Studio and storage are optional integrations
behind the bundled executable; their implementation modules are not public subpaths.
Directory names describe internal ownership. Keep implementation tests beside
their source files.

| Directory     | Responsibility                                                                                                                               |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `core/`       | Pipeline definitions, graph planning, execution, lifecycle and progress                                                                      |
| `agent/`      | In-process decision validation, handler/pipeline tools, owned state, shared subtree admission                                                |
| `tracing/`    | Trace contracts, internal emission and exporter composition                                                                                  |
| `utilities/`  | Domain-independent cancellation, collections, batching, retry, rate limits, error branding and the checkpoint store contract                 |
| `cli/`        | Argument parsing, command declarations and pipeline adaptation                                                                               |
| `reporter/`   | Terminal reporting and live ticker rendering                                                                                                 |
| `render/`     | Plan and error formatting                                                                                                                    |
| `run-store/`  | Event reader/store contracts, projection, SQLite and NDJSON adapters                                                                         |
| `studio/`     | HTTP server, browser client, page, state and UI protocol                                                                                     |
| `project/`    | Typed pipeline projects and parsed pipeline document compilation                                                                             |
| `hosting/`    | Platform-neutral deployment hosting: project commands, hosted execution, Studio host composition                                             |
| `cloudflare/` | Cloudflare deploy target: Access, Durable Object storage and execution, public `tubeless/cloudflare` and `tubeless/cloudflare/cache` entries |
| `workbench/`  | Module loading, executable integration and adapter wiring                                                                                    |
| `node/`       | Optional filesystem, path, environment, checkpoints and Node worker execution                                                                |
| `testing/`    | Test runtime and executable-example integration tests                                                                                        |

## Dependency direction

- Agent execution composes core pipelines and utilities. The root entrypoint and
  core never import agent code, providers, storage, or presentation. Handler
  tools validate arguments before dispatch and use private one-step pipelines;
  pipeline tools prevalidate child options using private prepared values.
  `agent/execution-scope.ts` owns ancestor budgets and leaf admission. Core
  carries that opaque scope through ordinary child execution and brackets leaf
  handlers; orchestration steps hold no permit. The internal child invocation
  boundary returns full reports for handler-origin error classification.
  `agent/default-tools.ts` supplies the standard registry against the typed
  environment and supplies typed activity formatters to the private tool compiler.
  `tool-progress.ts` starts action previews inside handlers. `tool-execution.ts` owns
  prepared-call invocation, validated results, failure classification and terminal
  activity logs for direct and code-mode calls. `turn.ts` owns batch progress and
  checkpoint transitions; completion labels belong to the mapped call group.
  `node-environment.ts` loads local filesystem, commands and
  guidance; explicit environments supply remote authority without local fallback.
  Custom names override defaults with matching type inference.
  `compile-agent.ts` compiles both custom-decision and model-backed agents through
  the same turn pipeline. `model-agent.ts` owns `defineAgent`: default or typed schemas,
  task mapping, prompting, an owned definition snapshot and per-run conversation state; `model-prompt.ts` builds the
  workspace or task-neutral prompt from environment guidance. `agent-session.ts` owns
  `createAgentSession`: a session compiles from that same snapshot with hooks that seed each run's
  initial conversation and observe each decision's, committing the finish conversation
  only after the run completes and finalizes.
  `chat-session.ts` uses a private versioned symbol to let the workbench request default task/answer
  sessions from the defining package instance, including separately installed copies.
  Typed agents retain ordinary session support but do not expose that CLI chat capability.
  `invocation.ts` owns environment resolution, checkpoint leases, terminal recovery
  and execution initialization. `checkpoint-session.ts` owns typed, acknowledged
  subtree transitions and persisted budget charges; callers cannot mutate the journal.
  `checkpoint-format.ts` validates phase/status unions and restored receipts before
  private prepared options are reused. `checkpoint-calls.ts` reconstructs accepted
  calls; `turn.ts` orchestrates decisions, calls and reduction through those operations.
  Runtime call identity is typed invocation data, independent of tracing attributes.
  Storage and lossless codecs are separate contracts; `tubeless/agent/node` supplies local environment and SQLite
  adapters. Traces remain best-effort inspection, independent of recovery.
  `transcript.ts` owns opt-in provider-neutral content records, bounded plain-JSON
  snapshots, redaction and serialized delivery. Its invocation-local capture follows
  the existing opaque agent scope through ordinary children and code-mode calls;
  entering a child agent resets capture unless that agent explicitly opts in.
  Provider modules publish only public text and successful compaction markers.
  Transcript sinks are application-owned and have no storage or trace dependencies.
  `agent-limits.ts` owns execution defaults and validation rules shared with
  checkpoint restoration. `default-tool-limits.ts` owns workspace bounds shared
  by tool schemas, adapters and guidance; `default-tool-text.ts` owns UTF-8
  clipping independently of filesystem operations.
  The optional `tubeless/agent/openai` and `tubeless/agent/anthropic` entrypoints own
  their provider protocols and compaction. They share `provider-http.ts` (bounded
  requests and responses, bounded retries of transient failures, base URLs, deadlines
  that fail rather than cancel),
  `provider-schema.ts` (strict tool-parameter schemas) and `provider-tool-outputs.ts`
  (bounded tool results). `openai-http.ts` keeps OpenAI
  authentication-error handling: known codes, no raw provider messages. Shared
  `provider-usage.ts` records per-request numeric token/cache counters and
  timing through existing trace events, including compaction and reminder requests.
  The provider-independent agent entrypoint imports none of them.
  The optional `tubeless/agent/mcp` entrypoint owns MCP sessions (`mcp-session.ts`),
  HTTP and lazily loaded stdio transports, and schema adaptation. Transports and
  schemas consume pure wire contracts and parsing from `mcp-protocol.ts`, independently
  of session negotiation, deadlines and lifecycle. The entrypoint produces
  ordinary `defineTool` capabilities, so the agent runtime has no MCP concepts.
  `codemode.ts` compiles the optional code-mode capability over a compiled registry:
  an orchestration step that holds no leaf permit runs the script and dispatches each
  script call through `decision.ts` preparation and ordinary child execution, then a leaf
  step publishes the result or a recoverable `ToolError`. `codemode-declarations.ts`
  renders descriptors as TypeScript. `codemode-executor.ts` owns the public executor
  contract and the platform-neutral harness: deadline, cancellation, call dispatch,
  draining and failure classification. Executors only run one script and stop on abort.
  `codemode-realm.ts` holds the dependency-free in-sandbox setup shared by executors. The
  lazily loaded `codemode-node.ts` is the default worker-thread executor;
  `codemode-worker.ts` owns its `node:vm` realm, which exchanges only JSON text with the host.
  `testing/agent.example.test.ts` covers public recipes, including ordinary pipeline
  composition. Workbench history tests and the packed-artifact check exercise those
  recipes through the CLI; live model evaluations remain an opt-in script outside CI.

- Core uses utilities and internal trace emission. Its complete runtime import graph
  must stay independent of exporters, storage, UI, command parsing and presentation.
- Utilities and tracing have no runtime imports from other modules. Node helpers
  depend only on pure utilities, with cache storage re-exported through their
  public entrypoint. `utilities/worker-argv.ts` owns file-worker argument
  compatibility for Node adapters, agent code mode and terminal reporting.
  Tracing shares type-only pipeline contracts with core.
- Reporters and rendering consume core. Storage consumes core and trace contracts;
  storage never depends on the studio or workbench.
- Studio consumes storage and pure trace schemas, and accepts optional launcher/history capabilities.
  It shares type-only pipeline and CLI descriptors; it does not load command
  execution or a concrete storage adapter itself.
- CLI adapts pipelines with Node helpers and terminal reporters. It must not load
  workbench, storage or Studio, including through lazy imports.
  `cli-schema.ts` owns the supported inference subset, rejecting reference validation
  siblings instead of merging assertions. `cli-parser.ts` shares value validation
  across text and structured inputs; structured numbers retain their numeric type.
- The project compiler consumes
  core to build pipelines from parsed documents; it performs no parsing or I/O.
  Project entries accept explicit command adapters through type-only references;
  the project entrypoint has no runtime dependency on CLI, workbench, storage or Studio.
  Project tracing configuration references only trace contract types; workbench and
  hosting create the launch's application exporters and compose concrete destinations.
  `hosting/launch-tracing.ts` owns factory preparation, shared error reporting,
  and abort/drain rollback when a launch never reaches pipeline execution.
- Workbench is internal executable integration: it loads modules, selects storage
  adapters and supplies Studio launch capabilities. The public project API loads none of these.
  Normalize project pipelines and direct files into workbench
  registrations at loading boundaries. Commands and Studio use their lazy plan
  and command loaders rather than branching on the source kind.
- Hosting composes CLI command adapters, project, Studio and storage contracts for
  deployment targets. It never imports workbench, concrete storage adapters, the Node
  HTTP listener or platform modules. Workbench and deploy-target entrypoints consume it.
  `hosting/run-contract.ts` owns trusted run jobs, collector ingestion and launch trace
  context. `hosting/run.ts` owns execution admission, ordered batching, history bounds,
  cooperative deadlines and final delivery. Targets supply output/cwd and any
  application-exporter wrapper; the shared runner does not select a target or a global
  runtime limit. `hosting/launch-store.ts` defines the async operation-level
  persistence port; `hosting/launch-store-sqlite.ts` implements it directly over
  synchronous SQLite transactions and event appends on the same connection.
  History and launch mutations commit together; `failUnadmitted` checks admission
  atomically. Accepted batch replies carry the persisted root identity on replay;
  rejected terminal writes never advance the committed sequence.
  `hosting/run-coordinator.ts` owns launch validation, start acknowledgements,
  ingestion and cancellation through that store and a `HostedExecutor`. Its
  observed dispatch task arranges recovery before execution, independently of
  the response timeout. Targets own dispatch deduplication and recovery scheduling,
  without leaking stubs or alarms into the coordinator. Studio accepts async
  live-run reads. Drivers and event-store schema initialization remain target-owned.
  `hosting/process-executor.test-support.ts` exercises the shared contracts in a
  Node process; the CLI retains its existing execution lifecycle.
  See the [hosted execution and ingest design](../design/hosted-run-ingest.md) before
  exposing this trusted port to a network. HTTP ingestion is a proposed contract,
  with separate admission, credential, ownership and replay requirements.
- The Cloudflare target composes hosting, Studio and storage contracts inside Durable
  Objects. Only `cloudflare/cloudflare.ts` imports `cloudflare:workers`; nothing outside
  `cloudflare/` imports it, and its public declarations stay structural. The
  `tubeless/cloudflare/cache` entry (`cloudflare/cloudflare-cache.ts`) must stay free of
  `cloudflare:` imports so project modules that use it still load in Node.
  `cloudflare/cloudflare-run-contract.ts` owns Cloudflare's deadline limit,
  host-failure vocabulary and public trace context without loading execution.
  `cloudflare/cloudflare-run.ts` retains alarm/KV state, the watchdog and cleanup;
  its runner wrapper supplies console output, caps the shared job budget and wraps
  application exporters with Cloudflare's existing delivery policy.
  `cloudflare-tracing.ts` bounds optional application trace delivery by operation and
  run deadlines, independently of Studio ingestion's retry and abort policy.
  `cloudflare/cloudflare-codemode.ts` is the Worker Loader code-mode executor; it imports
  only agent's executor types and realm setup, which it embeds in each Dynamic Worker.
- Type-only imports can share contracts without loading their implementation.
  Avoid creating new cross-module contracts unless the consumer needs them.

`core/pipeline-entry.test.ts` checks the emitted runtime graph, including re-exports
and lazy imports, and rejects runtime import cycles. Keep its allowed dependency
list narrow when adding modules.
Run `make check` after changes; it builds before checking these boundaries.

## Execution ownership

- `createSteps().waitForInput` constructs an ordinary step with an application-owned
  read callback, cancellation, output validation, and dry-run skipping by default.
  It adds no terminal or UI dependency to core.

- `core/iteration.ts` owns bounded state transitions and retained iteration
  progress. It invokes the existing child runner; it does not reschedule the
  parent DAG or own a separate lifecycle engine.

- `core/pipeline-steps.ts` owns `createSteps` and its typed overloads per step kind.
  Definition types live in `core/pipeline-step-types.ts`; runtime construction for
  artifacts, child, mapped, remote and iteration steps lives in
  `core/pipeline-step-builders.ts`, which receives erased definitions.
- `core/pipeline-definition-validation.ts` produces validated graph order, targets,
  cache plans and required-finalizer metadata for compilation. Graph compilation
  consumes that order rather than sorting again. `core/child-execution.ts` owns
  inherited child runtime context; invocation-specific hooks and identities remain
  with their callers.

- `core/pipeline-execute.ts` coordinates a run: options validation, scheduling,
  step attempts, stop policy and finalization.
- `core/pipeline-execution-error.ts` owns execution and child error classes,
  cancellation classification, bounded diagnostics and original cause retention.
  Fan-out errors retain only the primary child run, bounded diagnostic snapshots,
  and leaf-handler exceptions for classification; they discard sibling run reports.
  Parent and child execution consume it; it imports neither executor nor run state.
- `core/lifecycle.ts` owns hook delivery, trace creation, scoped loggers and flushing.
  Executors pass run identity and consume lifecycle operations; only lifecycle
  imports the internal trace emitter. Nested loggers unwrap to the original sink
  so each child log is attributed once to its own run.
- `core/pipeline-cache.ts` owns opt-in cache keys, policy, encoding, and storage
  boundaries around ordinary handler execution. It imports no concrete stores or
  codecs eagerly. `utilities/cache-storage.ts` supplies a lazily loaded file store
  and V8 codec, also exposed by `tubeless/node`. Definition validation compiles
  cache plans once; graph construction retains those validated snapshots. The
  default codec checks round-trip equality before writing. The default-key and duration
  utilities handle canonical data and fixed age limits.
- `core/pipeline-run-state.ts` owns state transitions, outputs and terminal reports.
  It consumes only the lifecycle notifications it emits, without requiring logger
  or trace capabilities.

## Project compilation ownership

- `project/project-document.ts` validates document structure and owns path-aware
  document errors. It does not resolve application wiring or build pipelines.
- `project/project-registry.ts` owns registry contracts and validates named
  handlers, schemas and child adapters without invoking them. It has no runtime
  dependency on core or the compiler.
- `project/project-step-graph.ts` builds one pipeline's steps and links forward
  references. Mutable dependency arrays stay inside this module; child pipeline
  references go through the compiler's resolver. Core still validates graph semantics.
- `project/project-compiler.ts` owns document-wide composition, shared child
  instances, composition cycle detection and immutable collection metadata.

## Workbench execution ownership

- `workbench/workbench-command-specs.ts` owns the ordered command inventory, summaries,
  static options and completion metadata. `workbench/workbench.ts` binds a handler
  for every command and derives dispatch, root help and completion from that inventory.
  `workbench/workbench-subcommand.ts` uses it for parsing, help, typo suggestions and
  nested-command option validation. `workbench/workbench-completion.ts` reads the same
  metadata without executing command help or loading optional command implementations.

- `workbench/agent/command.ts` owns agent command validation and session setup.
  `workbench/agent/defined-agent.ts` reuses workbench registration to select an
  agent's chat session without invoking command mappings. Registrations supply
  the execution cwd and project tracing independently of command adapters.
  `workbench/agent/provider.ts` loads trusted factories or named provider registries,
  checks the selected configuration and credentials, and resolves its default model.
  `workbench/agent/builtin-providers.ts` supplies public-service presets through
  that same registry contract. Factories own API, endpoint and authentication choices;
  the resolver has no protocol dispatch. `cli/cli-agent-provider.ts` owns the public
  type-only configuration contract, without adding a runtime dependency on agents to CLI.
  `workbench/agent/environment.ts` parses explicitly selected dotenv files and
  merges them with the process environment without mutating global values.
  `workbench/agent/commands.ts` owns shared slash command declarations, help,
  parsing, and readline completion so these interfaces stay aligned.
  `workbench/agent/session.ts` owns prompt sequencing through native async iteration, REPL
  commands, retained conversation, and session cancellation. `workbench/agent/prompt.ts`
  owns each prompt's tracing, optional cancellable model initialization and agent run,
  disposing the standard pipeline reporter before publishing its outcome. Both modes
  use `createAgentSession`; the built-in agent delegates to each prompt's factory
  result, while a selected agent retains its own model. Nested turns and tool calls use existing
  progress hooks. It composes the existing model agent and configured model factory
  without changing their ownership.
  `workbench/agent/input.ts` uses readline's prompt API for terminals and bounded
  iteration for pipes; it owns the themed prompt, native Tab completion, and
  interactive input while work runs. Presentation reuses the reporter theme;
  execution uses the same interactive/plain reporter as pipeline CLI commands.

- `workbench/cloud/auth.ts` and `workbench/cloud/command.ts` own lazy first-party Cloud
  command orchestration and name/slug selection. `workbench/cloud/client.ts` owns bounded
  HTTP transport and request submission;
  `workbench/cloud/run-input.ts` owns run-argument combinations, bounded JSON
  file/stdin loading and preparation of input, source and admission key.
  `workbench/cloud/protocol.ts` owns independent
  wire types, strict response decoding, finite JSON validation, immutable source
  selectors, input bounds, errors shared by transport/input/authentication, and
  the canonical token validator.
  `workbench/cloud/config.ts` validates explicit/default service origins, and
  `workbench/cloud/credentials.ts` owns lazy native credentials. These modules never import
  selected pipeline files and remain outside public runtime entrypoints.
- `workbench/workbench-shared.ts` owns terminal-safe text formatting shared by
  local history and Cloud human output. Machine JSON retains original fields.
- `workbench/workbench-run.ts` owns the `run` command's arguments, trace destinations,
  and command execution, including capture of the root completion report for
  `run --json`. `workbench/workbench-run-json.ts` serializes that report and rejects
  finalized values that would lose data in JSON. The run command translates failures into terminal output and exit codes
  through the shared hosted-command operation; it does not open stores or trace files
  until after command parsing succeeds. Studio executes validated values through
  `hosting/hosting-commands.ts` directly.
  `workbench/workbench-bin.ts` reserves JSON stdout before loading application
  modules and routes process stdout writes and console output to stderr; the
  reusable workbench handlers leave process globals to their host.
- `workbench/workbench-ui.ts` loads and validates registrations, opens the chosen
  store, starts the HTTP server and closes these resources.
- `workbench/workbench-studio-launcher.ts` owns the collection of admitted launches,
  live run IDs, cancellation and busy state. Stop admission and release pending
  launch responses before closing the server, then drain executions before closing
  storage. The launcher and individual launch sessions receive only a trace exporter;
  they cannot query, clear or close the store.
- `workbench/workbench-launch-session.ts` owns one launch's acknowledgement after
  its start event is persisted, and tracks execution settlement and late failures.
- `workbench/workbench-launcher.ts` is the package `bin` target. It owns runtime
  selection and the missing or outdated Bun messages: started by Bun it loads the
  direct entry, started by Node.js it replaces the process with Bun.
  `workbench/workbench-runtime.ts` owns the minimum Bun version and those messages;
  `workbench/workbench-bin.ts` stays the direct entry for explicit callers.

The runtime graph check keeps launch execution independent of command entrypoints,
the HTTP server and concrete storage adapters.

## Terminal reporting ownership

- `reporter/interactive-reporter.ts` owns lifecycle state, redraw scheduling and
  terminal event listeners.
- `reporter/live-ticker.ts` owns worker startup, inline fallback, pending log replay
  and shutdown. It transfers output ownership before adopting the worker's last
  frame, so fallback can clear the rows already on screen.
- `reporter/live-ticker-frame.ts` owns animation tokens, line layout, width handling
  and cursor/frame painting through an injected writer. It does not start workers
  or timers. The inline ticker and worker use the same renderer.
- `reporter/live-ticker-protocol.ts` owns worker messages and shared-memory state:
  log acknowledgements, shutdown completion and exclusive output ownership.
  A takeover request revokes future worker writes even when acquiring the lock
  times out. Only a worker exit permits clearing an abandoned lock.

The emitted runtime graph check keeps the worker independent of ticker startup
and interactive reporter orchestration.

## History and Studio ownership

- `run-store/run-store.ts` defines the storage and snapshot contracts and coordinates
  incremental projection and caching. It groups runs by definition without reaching
  into a projection's mutable state.
- `run-store/run-store-sql.ts` owns the shared schema, statements, row mapping and list query
  for SQLite drivers; it imports no driver. `run-store/run-store-query.ts` owns event
  page defaults and adapter limit normalization shared by SQLite and NDJSON.
- `run-store/run-projection.ts` owns one run's metadata, attempts, progress and logs.
  It retains only required fields and copies retained identities and errors at the
  boundary. `run-store/definition-projection.ts` owns definition replacement and
  per-run start metadata, including timestamp and event-ID tie breaking.
- `run-store/agent-projection.ts` retains typed agent attempt summaries and the
  allowlisted model usage sums per turn; `agent-history.ts` joins agent, turn and call
  identities across recorded runs and merges that usage per agent, subtree and run
  without mixing models.
  Neither imports agent execution or a storage adapter. The workbench formats the
  joined history for text and JSON inspection.
- `run-store/run-store-reader.ts` owns cursor pagination for both CLI history and
  Studio. It orders and deduplicates pages, advances through short pages, enforces
  query filters and stops when the cursor cannot advance. Consumers control
  backpressure and retain responsibility for closing the reader.
  Run-detail reads page one subtree query and retain the supplied root snapshot.
  SQLite resolves descendants with a recursive query, including
  older read-only stores; NDJSON follows its in-memory parent index. Cursor and
  pipeline filters apply after discovering the subtree so they cannot sever links.
- `studio/server/state.ts` serializes reads and history clearing; it consumes
  only the reader's `listEvents` capability. `run-store/run-history.ts` owns the
  historical hierarchy, descendant activity and summary projection, refreshing
  aggregates while membership, parent links and start-time ordering stay unchanged.
  Studio reuses that index and unaffected summaries across revisions in
  `studio/server/history.ts`, rebuilding for structural changes or overlapping
  updates whose ancestor walks would exceed a full traversal. It owns search,
  summary pagination, child attribution and definition queries without a storage
  capability. `studio/server/run-details.ts` owns bounded detail retention, per-run
  cursors and eviction. The state queue serializes all detail reads and cache resets
  with history clearing; reset only after the maintenance adapter succeeds.
  Selected-run reads supply ancestry and direct-child summaries; definition metadata
  and its run pages load independently.
  `studio/browser/data-controller.ts` owns history queries and selection state.
  `studio/browser/run-detail-loader.ts` owns per-run reads for both the selection and
  expanded graph: coalesced revisions, retained successes, missing/error retries and
  request retirement. Views consume one selection union, and resource refreshes
  retain matching definition metadata without remounting its explorer.
  `studio/browser/definition-resource.ts` owns definition identity, loading and
  legacy/identified revision refresh shared by graph and history views.
  `run-store/run-history.ts` also attributes each nested run to the parent step that
  started it (`origin`), using iteration and agent-call links before pipeline matches.
- `studio/browser/app.tsx` composes the browser app: view selection, URL
  state, live refresh and history clearing. Feature views live beside it:
  `studio/browser/components/runs.tsx` (run list and detail), `studio/browser/components/pipelines.tsx`
  (command catalog and plan preview), and `studio/browser/components/launch.tsx` (launch form,
  value serialization and modal). `studio/browser/components/common.tsx` holds small shared pieces.
  `studio/browser/escape-dismiss.ts` gives modals priority over inspectors for Escape,
  including while a modal is busy, without depending on CSS selectors.
- `studio/browser/components/steps.tsx` owns step presentation shared by the timeline and
  graph. `studio/browser/graph/layout.ts` is a pure layered DAG layout;
  `studio/browser/graph/scene.ts` builds nested geometry and inspection indexes
  from recorded runs, owning its mutable working maps and returning read-only scene
  collections. It returns automatic expansion state without mutating its input.
  `graph/dependencies.ts` owns dependency kinds, edge states and per-step child totals
  shared by the scene, inspector and run views. `graph/graph.tsx` renders the scene,
  owns selection and reconciles the detail loaders for expanded runs. Scene construction
  loads neither UI components nor transport or server code; the emitted runtime graph
  test enforces this boundary. Shared history limits live in `studio/shared/limits.ts`
  so geometry and pagination do not need to load protocol validators.
  `studio/shared/children.ts` owns iteration/start-time ordering shared by server
  child pagination and browser graph geometry.
- `run-store/run-store-schema.ts` validates projected storage records;
  `studio/shared/schema.ts` defines the browser protocol. Both reuse pure
  trace schemas. Decode at the transport boundary instead of promoting partially
  checked objects to core or storage types. Conditional history refreshes preserve
  the browser's current snapshot when the revision, query and live launch IDs agree.
- `studio/server/api.ts` owns route behavior, command validation and API state.
  `studio/server/http.ts` owns HTTP parsing, response formatting and authority
  helpers. `studio/server/handler.ts` owns the platform-neutral request order:
  authentication, trusted host, Origin on mutations, mount, health, page, then API.
  `studio/server/page.ts` builds the page and CSP from an injected client script;
  `studio/server/client-script.ts` loads that script on Node. `studio/server/node-http.ts`
  bridges Node requests and responses to Fetch, and `studio/server/listener.ts` is only the
  Node listener adapter: bind address, wildcard Host trust and server closure. Keep API
  handling behind the handler's host and gateway checks. `studio/server/hosting.ts`
  validates operator configuration, raw mount paths and gateway credentials without
  loading stores or execution. Only the nonsecret mount enters page metadata;
  authentication remains outside core and the browser import graph.

History projection and API routes do not load pipeline execution, concrete storage
adapters or page assets. The emitted runtime graph test enforces this boundary.

## Internal layout

Use directories for feature ownership instead of repeating that ownership in every
filename. Studio separates `browser/` (the app, components and graph), `server/`
(request handling and Node adapters), and `shared/` (protocol, schemas and routes).
Workbench keeps agent command/session code in `agent/` and Cloud commands,
authentication and transport in `cloud/`. Keep tests beside their implementations;
use short role names such as `command.ts`, `session.ts` and `transport.ts` within
those directories. Import implementations directly rather than adding barrels for
internal folders. Public package subpaths remain the API boundary.

## Moving files

Update package export targets and the binary target when moving their implementations;
keep public subpath names stable. Update lint overrides, Knip entries, worker URLs,
and studio generation paths as needed. Regenerate the API inventory with
`bun run api:generate`: declaration hashes include internal paths even when the
public symbols and signatures are unchanged. Regenerate the browser client with
`bun run build` when its source or generated location changes.
