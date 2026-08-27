# Recipe index

Every linked TypeScript example is compiled by the package typecheck. Start with
the smallest example matching the workflow rather than assembling primitives
from the API inventory.

| Intent                                        | Executable recipe                                                        | Main primitives                                                    |
| --------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| Sequential import or ETL                      | [`typed-import.ts`](../examples/typed-import.ts)                         | `createSteps`, `dependsOn`, `requireOutputs`, `targets`            |
| Validate options, outputs, and results        | [`validated-boundaries.ts`](../examples/validated-boundaries.ts)         | Standard Schema, `outputSchema`, `resultSchema`                    |
| Inspect, plan, or graph a pipeline module     | [`typed-import.ts`](../examples/typed-import.ts)                         | `tubeless inspect`, `tubeless plan`, `tubeless graph`, `toMermaid` |
| Safe write/publish preview                    | [`publish-with-gates.ts`](../examples/publish-with-gates.ts)             | `dryRun`, `optionalDependsOn`, `skipAfterFailureOf`                |
| Deliberately omit unnecessary work            | [`conditional-step.ts`](../examples/conditional-step.ts)                 | `step.skippable`, valued skip, skip-aware output typing            |
| Preserve independent work after failure       | [`best-effort.ts`](../examples/best-effort.ts)                           | `continueOnError`, structured `run` result                         |
| Compose one reusable workflow                 | [`child-pipeline.ts`](../examples/child-pipeline.ts)                     | `fromPipeline`, `mapOptions`, `mapResult`                          |
| Fan out over runtime items                    | [`fan-out-progress.ts`](../examples/fan-out-progress.ts)                 | `forEachPipeline`, stable keys, concurrency, progress              |
| Show determinate progress                     | [`fan-out-progress.ts`](../examples/fan-out-progress.ts)                 | `reportProgress`, mapped-child progress                            |
| Retry and rate-limit remote calls             | [`resumable-enrichment.ts`](../examples/resumable-enrichment.ts)         | `withRetry`, `RateLimiter`, injected sleep and signal              |
| Resume durable long-running work              | [`resumable-enrichment.ts`](../examples/resumable-enrichment.ts)         | `dryRun`, `openCheckpoint`, `withCheckpointedBatch`                |
| Expose and run a typed command-line program   | [`cli-job.ts`](../examples/cli-job.ts)                                   | `definePipelineCommand`, conditional `mapOptions`, `tubeless run`  |
| Render plans and diagnostics                  | [`rendering.ts`](../examples/rendering.ts)                               | `renderPipelinePlan`, `renderPipelineError`                        |
| Handle cancellation and deterministic testing | [`cancellation-and-testing.ts`](../examples/cancellation-and-testing.ts) | `createPipelineTestRuntime`, captured status/progress              |
| Export JSON or OpenTelemetry lifecycle events | [`tracing.ts`](../examples/tracing.ts)                                   | trace context, attempt events, JSON exporter                       |
| Persist, inspect, and explicitly launch runs  | [`local-observability.ts`](../examples/local-observability.ts)           | SQLite store, `createPipelineRunProjector`, `definePipelineStudio` |

## Selection rules

1. Use an ordinary step for one unit of domain work.
2. Set `dryRun: "skip"` or provide a side-effect-free `dryRun` handler before
   exposing side-effecting work through CLI dry-run support.
3. Use `step.skippable` only for a successful policy decision, never to hide an error.
4. Use a child pipeline when the child has value independently; use a normal
   helper function when it does not.
5. Use `forEachPipeline` when every item needs child-pipeline lifecycle and
   reporting. Use `runConcurrent` for lightweight worker functions.
6. Use `definePipelineCommand` for pipeline scripts; use `defineCommand` only
   when the script is not centered on a pipeline. Preview selection with
   `command.plan()` or `tubeless plan`; do not simulate planning with `--plan`.
7. Declare public goals with `targets: [step]` on the pipeline, select their IDs
   for goal-oriented execution, and use `stepIds` only for an exact filter. Use
   `requireOutputs` when the final domain result is not meaningful without
   specific step outputs. Read plan `selectionReasons` instead of recreating
   target-closure logic in a CLI or application.
8. Use `tubeless/render` when plans or diagnostics cross a human or JSON
   presentation boundary; do not duplicate selection-reason or error formatting.
   Use `tubeless/reporter` for optional TTY run reporters; do not import them
   from `tubeless`.

For semantics behind these choices, read [core concepts](./concepts.md).
For workbench commands, read [the CLI](./cli.md). For the local run UI, read
[the studio](./studio.md).
