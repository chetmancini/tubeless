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
and lazy imports. Keep its allowed dependency list narrow when adding modules.
Run `make check` after changes; it builds before checking these boundaries.

## Moving files

Update package export targets and the binary target when moving their implementations;
keep public subpath names stable. Update lint overrides, Knip entries, worker URLs,
and studio generation paths as needed. Regenerate the API inventory with
`bun run api:generate`: declaration hashes include internal paths even when the
public symbols and signatures are unchanged. Regenerate the browser client with
`bun run build` when its source or generated location changes.
