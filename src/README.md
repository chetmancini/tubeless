# Source modules

Keep one dependency-free runtime with focused public entrypoints. `tubeless`
owns pipeline execution; `tubeless/cli` owns terminal command declarations;
`tubeless/project` owns typed
pipeline collections and declarative compilation.
Each public API has one entrypoint. Studio and storage are optional integrations
behind the bundled executable; their implementation modules are not public subpaths.
Directory names describe internal ownership. Keep implementation tests beside
their source files.

| Directory    | Responsibility                                                                                |
| ------------ | --------------------------------------------------------------------------------------------- |
| `core/`      | Pipeline definitions, graph planning, execution, lifecycle and progress                       |
| `agent/`     | In-process decision validation, handler/pipeline tools, owned state, shared subtree admission |
| `tracing/`   | Trace contracts, internal emission and exporter composition                                   |
| `utilities/` | Domain-independent cancellation, collections, batching, retry, rate limits and error branding |
| `cli/`       | Argument parsing, command declarations and pipeline adaptation                                |
| `reporter/`  | Terminal reporting and live ticker rendering                                                  |
| `render/`    | Plan and error formatting                                                                     |
| `run-store/` | Event reader/store contracts, projection, SQLite and NDJSON adapters                          |
| `studio/`    | HTTP server, browser client, page, state and UI protocol                                      |
| `project/`   | Typed pipeline projects and parsed pipeline document compilation                              |
| `workbench/` | Module loading, executable integration and adapter wiring                                     |
| `node/`      | Optional filesystem, path, environment, checkpoints and Node worker execution                 |
| `testing/`   | Test runtime and executable-example integration tests                                         |

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
  `AgentEnvironment`. `node-environment.ts` owns local filesystem, commands and
  guidance; explicit environments supply remote authority without local fallback.
  Custom names override defaults with matching type inference.
  `compile-agent.ts` compiles both custom-decision and model-backed agents through
  the same turn pipeline. `model-agent.ts` owns default schemas, prompting and
  per-run conversation state; `model-prompt.ts` builds prompts from environment guidance.
  `invocation.ts` owns environment resolution and invocation-local scope creation.
  `tubeless/agent/node` exposes the optional local workspace adapter.
  The optional `tubeless/agent/openai` entrypoint owns HTTP, provider protocol and
  compaction. The provider-independent agent entrypoint never imports it.
  `testing/agent.example.test.ts` covers public recipes, including ordinary pipeline
  composition. Workbench history tests and the packed-artifact check exercise those
  recipes through the CLI; live model evaluations remain an opt-in script outside CI.

- Core uses utilities and internal trace emission. Its complete runtime import graph
  must stay independent of exporters, storage, UI, command parsing and presentation.
- Utilities and tracing have no runtime imports from other modules. Node helpers
  are self-contained except for the cache utility re-export from their public entrypoint.
  Tracing shares type-only pipeline contracts with core.
- Reporters and rendering consume core. Storage consumes core and trace contracts;
  storage never depends on the studio or workbench.
- Studio consumes storage and pure trace schemas, and accepts optional launcher/history capabilities.
  It shares type-only pipeline and CLI descriptors; it does not load command
  execution or a concrete storage adapter itself.
- CLI adapts pipelines with Node helpers and terminal reporters. It must not load
  workbench, storage or Studio, including through lazy imports.
- The project compiler consumes
  core to build pipelines from parsed documents; it performs no parsing or I/O.
  Project entries accept explicit command adapters through type-only references;
  the project entrypoint has no runtime dependency on CLI, workbench, storage or Studio.
- Workbench is internal executable integration: it loads modules, selects storage
  adapters and supplies Studio launch capabilities. The public project API loads none of these.
  Normalize project pipelines and direct files into workbench
  registrations at loading boundaries. Commands and Studio use their lazy plan
  and command loaders rather than branching on the source kind.
- Type-only imports can share contracts without loading their implementation.
  Avoid creating new cross-module contracts unless the consumer needs them.

`core/pipeline-entry.test.ts` checks the emitted runtime graph, including re-exports
and lazy imports, and rejects runtime import cycles. Keep its allowed dependency
list narrow when adding modules.
Run `make check` after changes; it builds before checking these boundaries.

## Execution ownership

- `core/iteration.ts` owns bounded state transitions and retained iteration
  progress. It invokes the existing child runner; it does not reschedule the
  parent DAG or own a separate lifecycle engine.

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

- `workbench/workbench-run.ts` owns the `run` command's arguments and trace destinations.
- `workbench/workbench-command-execution.ts` executes command arguments or validated
  values and translates failures into terminal output and exit codes. Both `run`
  and Studio use it; it does not open stores or trace files.
- `workbench/workbench-ui.ts` loads and validates registrations, opens the chosen
  store, starts the HTTP server and closes these resources.
- `workbench/workbench-studio-launcher.ts` owns the collection of admitted launches,
  live run IDs, cancellation and busy state. Stop admission and release pending
  launch responses before closing the server, then drain executions before closing
  storage. The launcher and individual launch sessions receive only a trace exporter;
  they cannot query, clear or close the store.
- `workbench/workbench-launch-session.ts` owns one launch's acknowledgement after
  its start event is persisted, and tracks execution settlement and late failures.

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
- `run-store/run-projection.ts` owns one run's metadata, attempts, progress and logs.
  It retains only required fields and copies retained identities and errors at the
  boundary. `run-store/definition-projection.ts` owns definition replacement and
  per-run start metadata, including timestamp and event-ID tie breaking.
- `run-store/agent-projection.ts` retains typed agent attempt summaries;
  `agent-history.ts` joins agent, turn and call identities across recorded runs.
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
- `studio/run-store-ui-state.ts` serializes reads and history clearing; it consumes
  only the reader's `listEvents` capability. `run-store/run-history.ts` owns the
  historical hierarchy, descendant activity and summary projection. Studio retains
  that index per history revision, pages root summaries and searches the complete
  hierarchy on the server. Selected-run reads supply ancestry and direct-child
  summaries; definition reads supply complete snapshots and paged runs.
- `run-store/run-store-schema.ts` validates projected storage records;
  `studio/run-store-ui-schema.ts` defines the browser protocol. Both reuse pure
  trace schemas. Decode at the transport boundary instead of promoting partially
  checked objects to core or storage types. Conditional history refreshes preserve
  the browser's current snapshot when the revision, query and live launch IDs agree.
- `studio/run-store-ui-api.ts` owns route behavior, command validation and API state.
  `studio/run-store-ui-http.ts` owns HTTP parsing, response formatting and authority
  helpers. `studio/run-store-ui.ts` owns the listener, trusted-host enforcement,
  page assets, CSP and server closure. Keep API handling behind the listener's
  host and gateway checks. `studio/run-store-ui-hosting.ts` validates operator
  configuration, raw mount paths, gateway credentials, and browser Origin without
  loading stores or execution. Only the nonsecret mount enters page metadata;
  authentication remains outside core and the browser import graph.

History projection and API routes do not load pipeline execution, concrete storage
adapters or page assets. The emitted runtime graph test enforces this boundary.

## Moving files

Update package export targets and the binary target when moving their implementations;
keep public subpath names stable. Update lint overrides, Knip entries, worker URLs,
and studio generation paths as needed. Regenerate the API inventory with
`bun run api:generate`: declaration hashes include internal paths even when the
public symbols and signatures are unchanged. Regenerate the browser client with
`bun run build` when its source or generated location changes.
