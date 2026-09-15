# Recipe index

Choose the example closest to your task, then adapt its inputs, step IDs, and
outputs. Each linked TypeScript example uses public package imports and is
compiled and checked against the packaged library.

For an existing script or workflow, use `tubeless-make-pipeline` from the
[agent skill pack](./agent-skills.md) to choose step boundaries before adapting
one of these recipes.

| Intent                                         | Executable recipe                                                        | Main primitives                                                              |
| ---------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| Sequential import or ETL                       | [`typed-import.ts`](../examples/typed-import.ts)                         | `createSteps`, `dependsOn`, `requireOutputs`, `targets`                      |
| Validate options, outputs, and results         | [`validated-boundaries.ts`](../examples/validated-boundaries.ts)         | Standard Schema, `outputSchema`, `resultSchema`                              |
| Inspect, plan, or graph a pipeline or command  | [`typed-import.ts`](../examples/typed-import.ts)                         | `tubeless inspect`, `tubeless plan`, `tubeless graph`, `toMermaid`           |
| Safe write/publish preview                     | [`publish-with-gates.ts`](../examples/publish-with-gates.ts)             | `dryRun`, `optionalDependsOn`, `skipAfterFailureOf`                          |
| Deliberately omit unnecessary work             | [`conditional-step.ts`](../examples/conditional-step.ts)                 | `step.skippable`, valued skip, skip-aware output typing                      |
| Preserve independent work after failure        | [`best-effort.ts`](../examples/best-effort.ts)                           | `continueOnError`, structured `run` result                                   |
| Compose one reusable workflow                  | [`child-pipeline.ts`](../examples/child-pipeline.ts)                     | `fromPipeline`, `mapOptions`, resolved async `mapResult`                     |
| Call a real HTTP service                       | [`remote-steps.ts`](../examples/remote-steps.ts)                         | `fromRemote`, fetch cancellation, validated HTTP output                      |
| Host a pipeline in a durable engine            | [`host-embedding.ts`](../examples/host-embedding.ts)                     | `runOrThrow`, pass `runId` / `parentRunId`                                   |
| Fan out over runtime items                     | [`fan-out-progress.ts`](../examples/fan-out-progress.ts)                 | `forEachPipeline.skippable`, stable keys, concurrency, progress              |
| Inspect keyed fan-out failures                 | [`fan-out-progress.ts`](../examples/fan-out-progress.ts)                 | `error.fanOut`, bounded diagnostics, caller-directed reruns                  |
| Show determinate progress                      | [`fan-out-progress.ts`](../examples/fan-out-progress.ts)                 | `reportProgress`, bounded live CLI rows, complete final trees                |
| Watch the live TTY reporter                    | [`live-tui.ts`](../examples/live-tui.ts)                                 | named steps, nested `details`; persist with `--store`                        |
| Retry and rate-limit remote calls              | [`resumable-enrichment.ts`](../examples/resumable-enrichment.ts)         | `withRetry`, `RateLimiter`, injected sleep and signal                        |
| Resume durable long-running work               | [`resumable-enrichment.ts`](../examples/resumable-enrichment.ts)         | `dryRun`, `openCheckpoint`, `withCheckpointedBatch`                          |
| Expose and run a typed command-line program    | [`cli-job.ts`](../examples/cli-job.ts)                                   | `definePipelineCommand`, conditional `mapOptions`, `tubeless run`            |
| Render plans and diagnostics                   | [`rendering.ts`](../examples/rendering.ts)                               | `renderPipelinePlan`, `renderPipelineError`                                  |
| Handle cancellation and deterministic testing  | [`cancellation-and-testing.ts`](../examples/cancellation-and-testing.ts) | `createPipelineTestRuntime`, captured status/progress                        |
| Export JSON or OpenTelemetry lifecycle events  | [`tracing.ts`](../examples/tracing.ts)                                   | trace context, exporter composition, JSON / OTel, `onExporterError`          |
| Persist, port, inspect, launch, or cancel runs | [`local-observability.ts`](../examples/local-observability.ts)           | SQLite / NDJSON stores, `tubeless history --pipeline <id>`, studio projector |
| Watch many primitives in one run               | [`peloton.ts`](../examples/peloton.ts)                                   | delays, logs, children, fan-out, retry, gates, test runtime                  |
| Project layout, IDs, and command manifest      | [`tubeless.project.ts`](../examples/catalog/tubeless.project.ts)         | `pipelines/`, `scripts/`, `definePipelineProject`, `tubeless list`           |

## Choose a pattern

1. Use an ordinary step for one unit of domain work.
2. Set `dryRun: "skip"` or provide a side-effect-free `dryRun` handler before
   exposing side-effecting work through CLI dry-run support.
3. Use `step.skippable` only for a successful policy decision, never to hide an error.
4. Use a child pipeline when the child has value independently; use a normal
   helper function when it does not.
5. Use `forEachPipeline` when every item needs child-pipeline lifecycle and
   reporting. Opt into `forEachPipeline.skippable` when policy may omit the
   whole fan-out and a skip should appear in reports. Use `runConcurrent`
   for lightweight worker functions that should
   throw on the first failure. Use `runConcurrentSettled` when the caller needs
   completed results plus that failure without throwing.

6. Use `definePipelineCommand` for pipeline scripts; use `defineCommand` only
   when the script is not centered on a pipeline. Preview selection with
   `command.plan()` or `tubeless plan`; do not simulate planning with `--plan`.
   `--step` and `--target` are argv flags; `mapOptions` and hooks read `stepIds`
   and `targets`.
7. Declare public goals with `targets: [step]` on the pipeline, select their IDs
   for goal-oriented execution, and use `stepIds` only for an exact filter. Use
   `requireOutputs` when the final domain result is not meaningful without
   specific step outputs. Read plan `selectionReasons` instead of recreating
   target-closure logic in a CLI or application.
8. Use `tubeless/render` to format plans and errors as text or JSON. It includes
   formatting for selection reasons and error details.
   Use `tubeless/reporter` for optional TTY run reporters; do not import them
   from `tubeless`.
9. Use the file layout and export conventions in the
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
[the studio](./studio.md).
