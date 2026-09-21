# Recipe index

Choose the example closest to your task, then adapt its inputs, step IDs, and
outputs. Each linked TypeScript example uses public package imports and is
compiled and checked against the packaged library.

For an existing script or workflow, use `tubeless-make-pipeline` from the
[agent skill pack](./agent-skills.md) to choose step boundaries before adapting
one of these recipes.

| Intent                                        | Executable recipe                                                        | Main primitives                                                                    |
| --------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| Single goal with default target and result    | [`minimal-pipeline.ts`](../examples/minimal-pipeline.ts)                 | `definePipeline({ id, steps })`                                                    |
| Run independent DAG branches concurrently     | [`parallel-dag.ts`](../examples/parallel-dag.ts)                         | `maxConcurrency` / CLI `--max-concurrency`, dependency joins, stable final reports |
| CPU parallelism on Node worker threads        | [`worker-threads.ts`](../examples/worker-threads.ts)                     | `createWorkerThreadAdapter`, `fromRemote`, structured clone, pool ownership        |
| Sequential import or ETL                      | [`typed-import.ts`](../examples/typed-import.ts)                         | `createSteps`, `dependsOn`, `requireOutputs`, `targets`                            |
| Define and compose pipelines in YAML or JSON  | [`yaml-pipelines.ts`](../examples/yaml-pipelines.ts)                     | `compilePipelineDocument`, adapters, skips, child fan-out                          |
| Validate options, outputs, and results        | [`validated-boundaries.ts`](../examples/validated-boundaries.ts)         | Standard Schema, `outputSchema`, `resultSchema`                                    |
| Inspect, plan, or graph a pipeline or command | [`typed-import.ts`](../examples/typed-import.ts)                         | `tubeless inspect`, `tubeless plan`, `tubeless graph`, `toMermaid`                 |
| Safe write/publish preview                    | [`publish-with-gates.ts`](../examples/publish-with-gates.ts)             | `dryRun`, `optionalDependsOn`, `skipAfterFailureOf`                                |
| Deliberately omit unnecessary work            | [`conditional-step.ts`](../examples/conditional-step.ts)                 | `step` with `skip`, valued skip, skip-aware output typing                          |
| Preserve independent work after failure       | [`best-effort.ts`](../examples/best-effort.ts)                           | `continueOnError`, structured `run` result                                         |
| Compose one reusable workflow                 | [`child-pipeline.ts`](../examples/child-pipeline.ts)                     | `fromPipeline`, `mapOptions`, resolved async `mapResult`                           |
| Call a real HTTP service                      | [`remote-steps.ts`](../examples/remote-steps.ts)                         | `fromRemote`, fetch cancellation, validated HTTP output                            |
| Host a pipeline in a durable engine           | [`host-embedding.ts`](../examples/host-embedding.ts)                     | `runOrThrow`, pass `correlationId` / `parentRunId`                                 |
| Fan out over runtime items                    | [`fan-out-progress.ts`](../examples/fan-out-progress.ts)                 | `forEachPipeline` with `skip`, stable keys, concurrency, progress                  |
| Inspect keyed fan-out failures                | [`fan-out-progress.ts`](../examples/fan-out-progress.ts)                 | `error.fanOut`, bounded diagnostics, caller-directed reruns                        |
| Show determinate progress                     | [`fan-out-progress.ts`](../examples/fan-out-progress.ts)                 | `reportProgress`, bounded live CLI rows, complete final trees                      |
| Watch the live TTY reporter                   | [`live-tui.ts`](../examples/live-tui.ts)                                 | named steps, nested `details`, pane-only logs; `reporter.logPane`                  |
| Retry and rate-limit remote calls             | [`resumable-enrichment.ts`](../examples/resumable-enrichment.ts)         | `withRetry`, `RateLimiter`, injected sleep and signal                              |
| Resume durable long-running work              | [`resumable-enrichment.ts`](../examples/resumable-enrichment.ts)         | `dryRun`, `openCheckpoint`, `withCheckpointedBatch`                                |
| Write local pipeline artifacts                | [`node-artifacts.ts`](../examples/node-artifacts.ts)                     | `definePaths`, atomic `writeJson`, `context.cwd`, `dryRun`                         |
| Turn a schema-backed pipeline into a CLI      | [`automatic-cli.ts`](../examples/automatic-cli.ts)                       | `definePipelineCommand(pipeline)`, inferred flags, automatic reporting             |
| Map custom command inputs to pipeline options | [`cli-job.ts`](../examples/cli-job.ts)                                   | `definePipelineCommand`, conditional `mapOptions`, `tubeless run`                  |
| Handle cancellation and deterministic testing | [`cancellation-and-testing.ts`](../examples/cancellation-and-testing.ts) | `createPipelineTestRuntime`, captured status/progress                              |
| Export lifecycle events                       | [`tracing.ts`](../examples/tracing.ts)                                   | app-owned JSON / OTel adapters, composition, `onExporterError`                     |
| Watch many primitives in one run              | [`peloton.ts`](../examples/peloton.ts)                                   | delays, logs, children, fan-out, retry, gates, test runtime                        |
| Watch an advanced YAML pipeline               | [`yaml-peloton.ts`](../examples/yaml-peloton.ts)                         | declarative graph, concurrent handlers, retries, progress, dry runs, gates         |
| Project layout, IDs, and command manifest     | [`tubeless.project.ts`](../examples/catalog/tubeless.project.ts)         | `pipelines/`, `scripts/`, `definePipelineProject`, `tubeless list`                 |

## Node helpers

`tubeless/node` provides optional helpers for pipelines that use the local
filesystem, environment, and worker threads. It uses Node built-ins and adds no runtime package
dependencies. Importing core does not load these helpers.

| Helper                                    | Behavior                                                                                                                                                                            |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `definePaths({ name: "relative/path" })`  | Returns a factory; pass `context.cwd` on each run. Keys are preserved and resolved values have type `string`.                                                                       |
| `readJson<T>(path)`                       | Synchronously parses JSON; missing files and malformed JSON throw. The type parameter does not validate data.                                                                       |
| `writeJson(path, value)`                  | Writes pretty JSON with a trailing newline, creates parent directories, and replaces the file by renaming a sibling temporary file. Serialization must succeed before disk changes. |
| `resetDir(path)`                          | Recursively deletes the directory and recreates it empty. Use for generated output only.                                                                                            |
| `requireEnv(name, usedBy)`                | Reads the environment when called and throws a descriptive error for missing or empty values.                                                                                       |
| `createWorkerThreadAdapter`               | Reuses a bounded Node worker pool for explicit module exports; validates results through `fromRemote`. The caller owns `close()`.                                                   |
| `openCheckpoint`, `withCheckpointedBatch` | Track completed work for resumable pipelines.                                                                                                                                       |

`writeJson` throws when the value has no JSON representation, including top-level
`undefined`, functions, symbols, and values whose `toJSON` returns `undefined`.
Serialization failures leave existing files and directories untouched.
Each write uses its own temporary file, including across worker threads. Concurrent
writes replace complete files; the last rename wins. This does not merge checkpoint
updates or provide a lock for read-modify-write operations.

Filesystem helpers do not know whether a pipeline is in dry-run mode. Put writes and
directory resets in steps marked `dryRun: "skip"`, as in
[`node-artifacts.ts`](../examples/node-artifacts.ts). Validate untrusted JSON at
the boundary with a schema; `readJson<T>` alone is not validation. Read required
environment values during execution so importing, inspecting and planning a
pipeline does not require credentials.

## Choose a pattern

1. Use an ordinary step for one unit of domain work.
2. Set `dryRun: "skip"` or provide a side-effect-free `dryRun` handler before
   exposing side-effecting work through CLI dry-run support.
3. Add `skip` only for a successful policy decision, never to hide an error.
4. Use a child pipeline when the child has value independently; use a normal
   helper function when it does not.
5. Use `forEachPipeline` when every item needs child-pipeline lifecycle and
   reporting. Add `skip` to `forEachPipeline` when policy may omit the whole
   fan-out and a skip should appear in reports. Use `runConcurrent`
   for lightweight worker functions that should
   throw on the first failure. Use `runConcurrentSettled` when the caller needs
   completed results plus that failure without throwing.

6. Start with `definePipelineCommand(pipeline)` from `tubeless/cli` for pipeline scripts.
   It infers flags from the options schema's Standard JSON Schema input metadata.
   Use `overrides` for presentation only; explicit `params` and `mapOptions` are
   advanced options for type-only pipelines or custom input shapes.
   Non-string `enum`/`const` constraints also require explicit parameters.
   Use `defineCommand` from the same entrypoint for standalone scripts and
   `definePipelineProject` from `tubeless/project` for project catalogs shared
   by terminal commands and Studio.
   Preview selection with
   `command.plan()` or `tubeless plan`; do not simulate planning with `--plan`.
   `--step` and `--target` are argv flags; `mapOptions` and hooks read `stepIds`
   and `targets`.
7. Declare public goals with `targets: [step]` on the pipeline, select their IDs
   for goal-oriented execution, and use `stepIds` only for an exact filter. Omitted
   `targets` exposes the last step in execution order; `targets: []` opts out. Omitted
   `finalize` returns that step's output or `undefined` if absent. Use
   `requireOutputs` when the final domain result is not meaningful without
   specific step outputs. Read plan `selectionReasons` instead of recreating
   target-closure logic in a CLI or application.
8. Use the file layout and export conventions in the
   [project manifest](../examples/catalog/tubeless.project.ts), adapting IDs to
   your own commands. Register project commands explicitly; do not infer executable modules from run
   history or the filesystem.
   Cancel only a live launch owned by the current studio process; it is not
   crash-resume and does not abort sibling launches.

Use `fromRemote` when a step calls another execution system. If a dry run
contacts that system, both the adapter and remote worker must honor
`context.dryRun`. A worker or durable host can invoke the whole pipeline when
it needs to own job delivery and retries; see [remote steps](./remote-step-composition.md).

For dependency, failure, and selection behavior, read [core concepts](./concepts.md).
For workbench commands, read [the CLI](./cli.md). For the local run UI, read
[the studio](./studio.md). To connect historical runs to a compiled graph and handler
release, set `implementationVersion` as shown in [tracing](../examples/tracing.ts).
Studio's [definition history](./studio.md#definition-history-and-comparison) groups
runs by definition and compares observed versions. Complete recorded snapshots must
match their hashes, including recorded child implementation identities, to be accepted
by NDJSON or SQLite history.
