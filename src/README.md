# Source modules

Keep one dependency-free runtime with focused public entrypoints. `tubeless`
owns pipeline execution; `tubeless/cli` adds command and project declarations.
Studio and storage are optional integrations behind the bundled executable;
their implementation modules are not public subpaths. `tubeless/workbench`
retains its command and project registration aliases for existing consumers.
Directory names describe internal ownership. Keep implementation tests beside
their source files.

| Directory    | Responsibility                                                                                |
| ------------ | --------------------------------------------------------------------------------------------- |
| `core/`      | Pipeline definitions, graph planning, execution, lifecycle and progress                       |
| `tracing/`   | Trace contracts, internal emission and exporter composition                                   |
| `utilities/` | Domain-independent cancellation, collections, batching, retry, rate limits and error branding |
| `cli/`       | Argument parsing, command declarations, pipeline adaptation and project catalog contracts     |
| `reporter/`  | Terminal reporting, prompts and ticker workers                                                |
| `render/`    | Plan and error formatting                                                                     |
| `run-store/` | Event reader/store contracts, projection, SQLite and NDJSON adapters                          |
| `studio/`    | HTTP server, browser client, page, state and UI protocol                                      |
| `workbench/` | Executable commands, module and catalog loading, and integration wiring                       |
| `node/`      | Filesystem, paths, environment and checkpoints                                                |
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
- CLI adapts pipelines with Node helpers and terminal reporters, and declares
  project catalogs without loading their command modules. It must not load
  workbench, storage or Studio, including through lazy imports. Workbench owns
  integration wiring, including selecting storage adapters and supplying studio
  launch capabilities.
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
`bun run studio:generate` when its source or generated location changes.
