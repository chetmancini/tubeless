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

- Core uses utilities and internal trace emission. Its complete runtime import graph
  must stay independent of exporters, storage, UI, command parsing and presentation.
- Utilities, Node helpers and tracing have no runtime imports from other modules.
  Tracing shares type-only pipeline contracts with core.
- Reporters and rendering consume core. Storage consumes core and trace contracts;
  storage never depends on the studio or workbench.
- Studio consumes storage and accepts optional launcher/history capabilities.
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

- `core/pipeline-execute.ts` coordinates a run: options validation, scheduling,
  step attempts, stop policy and finalization.
- `core/pipeline-execution-error.ts` owns execution and child error classes,
  cancellation classification, bounded diagnostics and original cause retention.
  Parent and child execution consume it; it imports neither executor nor run state.
- `core/lifecycle.ts` owns hook delivery, trace creation, scoped loggers and flushing.
  Executors pass run identity and consume lifecycle operations; only lifecycle
  imports the internal trace emitter. Nested loggers unwrap to the original sink
  so each child log is attributed once to its own run.
- `core/pipeline-run-state.ts` owns state transitions, outputs and terminal reports.
  It consumes only the lifecycle notifications it emits, without requiring logger
  or trace capabilities.

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

## History and Studio ownership

- `run-store/run-store.ts` defines the storage and snapshot contracts and coordinates
  incremental projection and caching. It groups runs by definition without reaching
  into a projection's mutable state.
- `run-store/run-projection.ts` owns one run's metadata, attempts, progress and logs.
  It retains only required fields and copies retained identities and errors at the
  boundary. `run-store/definition-projection.ts` owns definition replacement and
  per-run start metadata, including timestamp and event-ID tie breaking.
- `run-store/run-store-reader.ts` owns cursor pagination for both CLI history and
  Studio. It orders and deduplicates pages, advances through short pages, enforces
  query filters and stops when the cursor cannot advance. Consumers control
  backpressure and retain responsibility for closing the reader.
- `studio/run-store-ui-state.ts` serializes reads and history clearing; it consumes
  only the reader's `listEvents` capability.
- `studio/run-store-ui-api.ts` owns route behavior, command validation and API state.
  `studio/run-store-ui-http.ts` owns HTTP parsing, response formatting and authority
  helpers. `studio/run-store-ui.ts` owns the listener, trusted-host enforcement,
  page assets, CSP and server closure. Keep API handling behind the listener's
  host check.

History projection and API routes do not load pipeline execution, concrete storage
adapters or page assets. The emitted runtime graph test enforces this boundary.

## Moving files

Update package export targets and the binary target when moving their implementations;
keep public subpath names stable. Update lint overrides, Knip entries, worker URLs,
and studio generation paths as needed. Regenerate the API inventory with
`bun run api:generate`: declaration hashes include internal paths even when the
public symbols and signatures are unchanged. Regenerate the browser client with
`bun run build` when its source or generated location changes.
