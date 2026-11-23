# Recipe index

Choose the example closest to your task, then adapt its inputs, step IDs, and
outputs. Each linked TypeScript example uses public package imports and is
compiled and checked against the packaged library.

For an existing script or workflow, use `tubeless-make-pipeline` from the
[agent skill pack](./agent-skills.md) to choose step boundaries first.

For an explicit Node 24/Bun repository gate, see [the portable check recipe](node-check-recipe.md) and [`node-check.ts`](../examples/node-check.ts).

For optional structured Vitest failures, see [the diagnostic contract](structured-diagnostics.md).
For headless Cloud submission, see [Cloud CLI](./cli.md#tubeless-cloud).
For attaching to an admitted run or resuming after a disconnect, see
[Follow and read results](./cli.md#follow-and-read-results).

| Intent                                                  | Executable recipe                                                                                                                                       | Main primitives                                                                                                  |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Run all steps with a default result                     | [`minimal-pipeline.ts`](../examples/minimal-pipeline.ts)                                                                                                | `definePipeline({ id, steps })`                                                                                  |
| Sequential import or ETL                                | [`typed-import.ts`](../examples/typed-import.ts)                                                                                                        | `createSteps`, `dependsOn`, `requireOutputs`, `targets`                                                          |
| Return one step's exact result type                     | [`precise-result.ts`](../examples/precise-result.ts)                                                                                                    | `finalize: step`                                                                                                 |
| Omit empty inputs and identity child mapping            | [`inherited-inputs.ts`](../examples/inherited-inputs.ts)                                                                                                | `runOrThrow()`, `fromPipeline`                                                                                   |
| Validate options, outputs, and results                  | [`validated-boundaries.ts`](../examples/validated-boundaries.ts)                                                                                        | Standard Schema, `outputSchema`, `resultSchema`                                                                  |
| Safe write/publish preview                              | [`publish-with-gates.ts`](../examples/publish-with-gates.ts)                                                                                            | `dryRun`, `optionalDependsOn`, `skipAfterFailureOf`                                                              |
| Deliberately omit unnecessary work                      | [`conditional-step.ts`](../examples/conditional-step.ts)                                                                                                | `skip`, valued skip                                                                                              |
| Preserve independent work after failure                 | [`best-effort.ts`](../examples/best-effort.ts)                                                                                                          | `continueOnError`, `finalized` narrowing                                                                         |
| Run independent DAG branches concurrently               | [`parallel-dag.ts`](../examples/parallel-dag.ts)                                                                                                        | `maxConcurrency`, dependency joins                                                                               |
| Declare a static family of checks                       | [`parameterized-steps.ts`](../examples/parameterized-steps.ts)                                                                                          | Tuple helper, literal IDs; see [below](#static-step-families)                                                    |
| Reuse deterministic step outputs across runs            | [`step-output-cache.ts`](../examples/step-output-cache.ts)                                                                                              | Versioned opt-in cache; [contract](./step-output-cache.md)                                                       |
| Capture and supply raw step results                     | [`step-output-observation.ts`](../examples/step-output-observation.ts)                                                                                  | `outputObserver`, `suppliedOutputs`, lossless encoding, awaited writes; [contract](./step-output-observation.md) |
| Recover a partial run in a fresh host                   | [`step-output-recovery.ts`](../examples/step-output-recovery.ts)                                                                                        | Host-owned files, compatibility checks, `suppliedOutputs`; [guide](./step-output-recovery.md)                    |
| Compose one reusable workflow                           | [`child-pipeline.ts`](../examples/child-pipeline.ts)                                                                                                    | `fromPipeline`, `mapOptions`, `mapResult`                                                                        |
| Fan out over runtime items                              | [`fan-out-progress.ts`](../examples/fan-out-progress.ts)                                                                                                | `forEachPipeline`, stable keys, concurrency, `reportProgress`, `error.fanOut`                                    |
| Keep partial fan-out results                            | [`fan-out-partial-results.ts`](../examples/fan-out-partial-results.ts)                                                                                  | `onItemFailure: "collect"`                                                                                       |
| Repeat a child until a bounded finish decision          | [`iteration.ts`](../examples/iteration.ts)                                                                                                              | `iteratePipeline`, `next` / `finish`                                                                             |
| Define and compose pipelines in YAML or JSON            | [`yaml-pipelines.ts`](../examples/yaml-pipelines.ts)                                                                                                    | `compilePipelineDocument(document, registry)`; [guide](./declarative-pipelines.md)                               |
| Wait for user review before continuing                  | [`user-input.ts`](../examples/user-input.ts)                                                                                                            | `waitForInput`; [contract](./concepts.md#wait-for-user-or-application-input)                                     |
| Ask for choices, confirmation, or text in YAML          | [`yaml-user-input.ts`](../examples/yaml-user-input.ts)                                                                                                  | Registered `waitForInput(...).run`; [guide](./declarative-pipelines.md#user-decisions-confirmations-and-text)    |
| CPU parallelism on Node worker threads                  | [`worker-threads.ts`](../examples/worker-threads.ts)                                                                                                    | `createWorkerThreadAdapter`, `fromRemote`                                                                        |
| Call a real HTTP service                                | [`remote-steps.ts`](../examples/remote-steps.ts)                                                                                                        | `fromRemote`, fetch cancellation                                                                                 |
| Retry and rate-limit remote calls                       | [`resumable-enrichment.ts`](../examples/resumable-enrichment.ts)                                                                                        | `withRetry`, `RateLimiter`                                                                                       |
| Resume durable long-running work                        | [`resumable-enrichment.ts`](../examples/resumable-enrichment.ts)                                                                                        | `checkpoint`, `context.checkpoint`, `withCheckpointedBatch`                                                      |
| Record typed artifact reads and writes                  | [`artifact-lineage.ts`](../examples/artifact-lineage.ts)                                                                                                | `recordArtifact`, loaders/savers; [guide](./artifacts.md)                                                        |
| Write local pipeline artifacts                          | [`node-artifacts.ts`](../examples/node-artifacts.ts)                                                                                                    | `definePaths`, atomic `writeJson`, `dryRun`                                                                      |
| Turn a schema-backed pipeline into a CLI                | [`automatic-cli.ts`](../examples/automatic-cli.ts)                                                                                                      | `definePipelineCommand(pipeline)`, inferred flags                                                                |
| Map custom command inputs to pipeline options           | [`cli-job.ts`](../examples/cli-job.ts)                                                                                                                  | `definePipelineCommand`, `mapOptions`                                                                            |
| Inspect, plan, or graph a pipeline or command           | [`typed-import.ts`](../examples/typed-import.ts)                                                                                                        | `tubeless inspect`, `plan`, `graph`, `toMermaid`                                                                 |
| Read a run result from a script                         | [Run JSON output](./cli.md#run)                                                                                                                         | `tubeless run --json`                                                                                            |
| Start a project from nothing                            | [`starter/tubeless.project.ts`](../examples/starter/tubeless.project.ts)                                                                                | `tubeless init`; [init](./cli.md#init)                                                                           |
| Expose a project to CLI and Studio                      | [`tubeless.project.ts`](../examples/tubeless.project.ts)                                                                                                | `defineProject`, inferred flags, `tubeless list`                                                                 |
| Register custom command adapters                        | [`project/tubeless.project.ts`](../examples/project/tubeless.project.ts)                                                                                | `defineProject`, explicit command adapters                                                                       |
| Handle cancellation and deterministic testing           | [`cancellation-and-testing.ts`](../examples/cancellation-and-testing.ts)                                                                                | `createPipelineTestRuntime`                                                                                      |
| Supply intermediate outputs in tests                    | [`step-output-overrides.ts`](../examples/step-output-overrides.ts)                                                                                      | `overrideStep`                                                                                                   |
| Export lifecycle events                                 | [`tracing.ts`](../examples/tracing.ts)                                                                                                                  | JSON / OTel exporters, `onExporterError`, `implementationVersion`                                                |
| Observe lifecycle without changing execution            | [Lifecycle hooks](./concepts.md#step-statuses-and-structured-errors)                                                                                    | `onStep*` hooks                                                                                                  |
| Watch the live TTY reporter                             | [`live-tui.ts`](../examples/live-tui.ts)                                                                                                                | named steps, nested `details`                                                                                    |
| Watch many primitives in one run                        | [`peloton.ts`](../examples/peloton.ts), [`yaml-peloton.ts`](../examples/yaml-peloton.ts)                                                                | children, fan-out, retry, gates; YAML variant                                                                    |
| Annotate ownership and governance metadata              | [`graph-metadata.ts`](../examples/graph-metadata.ts)                                                                                                    | `metadata`, `querySteps`, `toMermaid({ query })`; [guide](./graph-metadata.md)                                   |
| Host a pipeline in a durable engine                     | [`host-embedding.ts`](../examples/host-embedding.ts)                                                                                                    | `runOrThrow`, `correlationId` / `parentRunId`                                                                    |
| Resume acknowledged pipeline steps in a host            | [`host-embedding.ts`](../examples/host-embedding.ts)                                                                                                    | `executionJournal`, stable logical paths; [contract](./execution-journal.md)                                     |
| Invoke an Airflow DAG and validate its result           | [`airflow/remote.ts`](../examples/airflow/remote.ts)                                                                                                    | `fromRemote`; [setup](./airflow.md)                                                                              |
| Run a pipeline inside an Airflow task                   | [`airflow/hosted.ts`](../examples/airflow/hosted.ts), [Python DAG](../examples/airflow/tubeless_example.py)                                             | `runOrThrow`, host-owned retries                                                                                 |
| Run a pipeline inside a Temporal Activity               | [`temporal/activities.ts`](../examples/temporal/activities.ts)                                                                                          | Activity retries, heartbeats; [setup](./temporal.md)                                                             |
| Run a pipeline inside an Inngest durable step           | [`inngest/functions.ts`](../examples/inngest/functions.ts)                                                                                              | `step.run`; [setup](./inngest.md)                                                                                |
| Materialize a Dagster asset with a pipeline             | [`dagster/hosted.ts`](../examples/dagster/hosted.ts), [Python asset](../examples/dagster/definitions.py)                                                | Dagster Pipes; [setup](./dagster.md)                                                                             |
| Run a pipeline on AWS Step Functions                    | [`step-functions/handler.ts`](../examples/step-functions/handler.ts), [SAM template](../examples/step-functions/template.json)                          | Lambda hosting; [setup](./step-functions.md)                                                                     |
| Deploy to your Cloudflare account                       | [`cloudflare/cloudflare.config.ts`](../examples/cloudflare/cloudflare.config.ts), [`cloudflare/worker.ts`](../examples/cloudflare/cloudflare/worker.ts) | `tubeless init cloudflare`, `createCloudflareApp`; [setup](./deploy-cloudflare.md)                               |
| Submit Cloudflare runs from cron or CLI                 | [`cloudflare/scheduled-worker.ts`](../examples/cloudflare/scheduled-worker.ts)                                                                          | `app.launch`, [`tubeless remote run`](./deploy-cloudflare.md#submit-and-follow-from-the-cli)                     |
| Place a Cloudflare pipeline or child on a Bun runner    | [Worker](../examples/cloudflare/runner-placement/worker.ts), [Bun project](../examples/cloudflare/runner-placement/runner.project.ts)                   | [Runner placement](./deploy-cloudflare.md#place-work-on-a-local-bun-runner)                                      |
| Resume a Worker pipeline after an interruption          | [Mixed-runner Worker](../examples/cloudflare/runner-placement/worker.ts)                                                                                | `recoverInterruptedRuns`, [Worker recovery](./deploy-cloudflare.md#recover-an-interrupted-worker-execution)      |
| Run a bounded in-process agent                          | [`agent.ts`](../examples/agent.ts)                                                                                                                      | `defineAgentLoop`, `defineTool`; [guide](./agents.md)                                                            |
| Run a model-backed workspace agent                      | [`agent-model.ts`](../examples/agent-model.ts)                                                                                                          | Default prompt, conversation, compaction; [setup](./agents.md#default-model-backed-agent)                        |
| Run the workspace agent on Claude                       | [`agent-model-anthropic.ts`](../examples/agent-model-anthropic.ts)                                                                                      | `anthropicModel()`; [providers](./agents.md#choose-a-model-provider)                                             |
| Let a real LLM choose tools and finish                  | [`agent-openai.ts`](../examples/agent-openai.ts)                                                                                                        | Application-owned Responses callback; [setup](./agents.md#connect-a-model)                                       |
| Configure named agent services                          | [`agent-providers.ts`](../examples/agent-providers.ts)                                                                                                  | `AgentProvider`; [CLI](./cli.md#configure-named-providers)                                                       |
| Run a typed agent over an extract step's output         | [`agent-extract.ts`](../examples/agent-extract.ts)                                                                                                      | `defineAgent` with `inputSchema`, `task`, `resultSchema`; [contract](./agents.md#typed-inputs-and-results)       |
| Embed an agent in an ordinary pipeline                  | [`agent-pipeline.ts`](../examples/agent-pipeline.ts)                                                                                                    | `fromPipeline`, validated child answers                                                                          |
| Delegate to subagents and ordinary pipelines            | [`agent-delegation.ts`](../examples/agent-delegation.ts)                                                                                                | `pipelineTool`, shared limits                                                                                    |
| Read, edit and check a workspace with default tools     | [`agent-workspace.ts`](../examples/agent-workspace.ts)                                                                                                  | Default read/write/edit/bash/list/search tools                                                                   |
| Supply local or remote workspace capabilities           | [`agent-environment.ts`](../examples/agent-environment.ts)                                                                                              | `AgentEnvironment`                                                                                               |
| Attach MCP server tools to an agent                     | [`agent-mcp.ts`](../examples/agent-mcp.ts)                                                                                                              | `connectMcpServers`; [contract](./agents.md#connect-mcp-servers)                                                 |
| Chain many tools from one agent script                  | [`agent-codemode.ts`](../examples/agent-codemode.ts)                                                                                                    | `defineAgentLoop({ codemode: true })`; [contract](./agents.md#code-mode)                                         |
| Chat with a project-defined agent                       | [`agent-chat.ts`](../examples/agent-chat.ts)                                                                                                            | `tubeless agent <id or file>`; [CLI](./cli.md#select-a-defined-agent)                                            |
| Prompt an agent repeatedly with live pipeline reporting | [`agent-repl-model.ts`](../examples/agent-repl-model.ts)                                                                                                | `tubeless agent`, `/clear`; [CLI](./cli.md#prompt-a-workspace-agent)                                             |
| Continue an application chat across prompts             | [Chat sessions](./agents.md#chat-sessions)                                                                                                              | `createAgentSession`                                                                                             |
| Resume a workspace agent after a restart                | [`agent-durable.ts`](../examples/agent-durable.ts)                                                                                                      | SQLite checkpoints; [contract](./agents.md#durable-execution)                                                    |
| Stream public agent text without credentials            | [`agent-transcript-model.ts`](../examples/agent-transcript-model.ts)                                                                                    | Scripted model, `--stream`; [contract](./agents.md#stream-public-assistant-text)                                 |
| Capture agent content with explicit redaction           | [`agent-transcript.ts`](../examples/agent-transcript.ts)                                                                                                | Opt-in transcripts; [contract](./agents.md#opt-in-transcripts)                                                   |
| Capture agent content on Cloudflare                     | [`agent-transcript-cloudflare.ts`](../examples/agent-transcript-cloudflare.ts)                                                                          | Durable Object history; [setup](./deploy-cloudflare.md#opt-in-agent-transcripts)                                 |
| Evaluate an agent with scripted model decisions         | [`agent-evaluation.ts`](../examples/agent-evaluation.ts)                                                                                                | `createAgentTranscriptCollector`; [guide](./agents.md#evaluate-your-own-agent)                                   |
| Host Studio beneath a private admin URL                 | [Gateway hosting](./studio.md#host-studio-behind-an-application-gateway)                                                                                | `--public-url`, server-only gateway token                                                                        |
| Complete commands, IDs, and flags in a shell            | [Shell completion](./cli.md#shell-completion)                                                                                                           | `tubeless completion bash\|zsh\|fish`                                                                            |
| Recover from mistyped CLI input                         | [Typos and suggestions](./cli.md#typos-and-suggestions)                                                                                                 | `Did you mean ...?`, `tubeless list`                                                                             |

For agent run history, record the [delegation recipe](../examples/agent-delegation.ts)
with `--trace` or `--store`, then use `tubeless history <run-id>` (add `--json`
for the structured projection).

## Static step families

Use [`parameterized-steps.ts`](../examples/parameterized-steps.ts) when several
statically known steps share an implementation. Its recipe-local
`defineRangeChecks` helper takes a readonly tuple of specifications and returns
an ordered tuple of ordinary steps. It is a pattern to adapt, not a package export.

- The family expands synchronously at module load. Spread it into `steps` and,
  when each check should be selectable, `targets`. Pass the tuple to `dependsOn`
  to join all checks, or one member to depend on one.
- Plans, traces, Mermaid, and Studio show each check as an ordinary step.
- Pass an inline tuple, or use `as const` on a separate list; a widened array
  loses literal IDs. The helper's one type assertion is justified only because
  every step returns the same output type; prefer explicit declarations for
  heterogeneous steps.
- Use `forEachPipeline` for items discovered during execution.
- The example has no side effects; declare a `dryRun` policy if you adapt it to
  write data.

```sh
bun run tubeless -- run --project examples/project/tubeless.project.ts order-checks -- --quantities 2 --quantities 3 --prices 10 --prices 5
bun run tubeless -- plan --project examples/project/tubeless.project.ts order-checks --target valid-prices
```

## Node helpers

`tubeless/node` provides optional helpers for the local filesystem, environment,
and worker threads, using only Node built-ins. Importing core never loads them.

| Helper                                    | Behavior                                                                                                                               |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `definePaths({ name: "relative/path" })`  | Returns a factory; pass `context.cwd` on each run.                                                                                     |
| `readJson<T>(path)`                       | Synchronously parses JSON; missing or malformed files throw. `T` does not validate data.                                               |
| `writeJson(path, value)`                  | Pretty JSON, creates parent directories, replaces atomically via a temporary file. Unserializable values throw before any disk change. |
| `resetDir(path)`                          | Recursively deletes and recreates the directory. Generated output only.                                                                |
| `requireEnv(name, usedBy)`                | Reads the environment when called; throws for missing or empty values.                                                                 |
| `createWorkerThreadAdapter`               | Bounded worker pool for explicit module exports, via `fromRemote`. The caller owns `close()`.                                          |
| `openCheckpoint`, `withCheckpointedBatch` | Track completed work for resumable pipelines.                                                                                          |

Concurrent `writeJson` calls replace complete files (last rename wins) but do not
merge updates or lock read-modify-write sequences. Filesystem helpers do not know
about dry runs: put writes and resets in steps marked `dryRun: "skip"`, as in
[`node-artifacts.ts`](../examples/node-artifacts.ts). Read required environment
values during execution so inspecting and planning need no credentials.

## Choose a pattern

1. Use an ordinary step for one unit of domain work.
2. Set `dryRun: "skip"` or a side-effect-free `dryRun` handler before exposing
   side-effecting work through CLI dry-run support.
3. Add `skip` only for a successful policy decision, never to hide an error.
4. Use a child pipeline when the child has value independently; otherwise use a
   helper function.
5. Use `forEachPipeline` when each item needs child-pipeline lifecycle and
   reporting. Use `runConcurrent` for lightweight workers that throw on the first
   failure, or `runConcurrentPartial` for completed results plus that failure
   without throwing (branch on `ok`, never `failure`; `completedIndexes` lists
   successes). Both stop admitting work after the first failure or abort, then
   drain active workers. `runBatched` and `runBatchedPartial` do the same for
   fixed-size batches.
6. Group pipelines with `defineProject(id, [pipelineA, pipelineB])` from
   `tubeless/project`, and use `project.get(id)` to keep exact option and result
   types. Use `PipelineInput<typeof pipeline>` and `PipelineResult<typeof pipeline>`
   in wrapper contracts. Compile parsed YAML or JSON with
   `compilePipelineDocument(document, registry)` and register selected pipelines.
   - A default-exported `defineProject` exposes its pipelines to the CLI and
     Studio, inferring flags from the options schema's Standard JSON Schema
     metadata. Without that metadata (or for non-string `enum`/`const`
     constraints), supply explicit command `params`; see
     [CLI inference](./cli.md#turn-a-pipeline-into-a-cli).
   - Register each pipeline exactly once, directly or through its command, in
     one mixed entry list. Duplicate pipeline IDs fail regardless of entry form.
   - Run a uniquely exported schema-backed pipeline file directly, or start
     customized scripts with `definePipelineCommand(pipeline)`; an explicit
     command wins over its pipeline. Use `--export` to pick among several.
   - `--step` and `--target` are argv flags; `mapOptions` and hooks read `stepIds`
     and `targets`. Preview with `command.plan()` or `tubeless plan`, not `--plan`.
   - Commands expose `--resume` only when an explicit adapter configures managed
     `checkpoint` support or sets `resume: true`.
7. Declare public goals with `targets: [step]`, select their IDs for
   goal-oriented runs, and use `stepIds` only as an exact filter; the types reject
   both together. Without selection controls every step runs. Use
   `requireOutputs` when the result is meaningless without specific outputs, and
   read plan `selectionReasons` instead of recreating target-closure logic.
8. Use the layout in the
   [project with custom adapters](../examples/project/tubeless.project.ts) only
   when custom adapters are needed. Do not infer executable modules from run
   history or the filesystem. See the
   [Studio controls](./studio.md#use-the-browser-controls).

Use `fromRemote` when a step calls another execution system. If a dry run
contacts that system, both adapter and worker must honor `context.dryRun`; a host
that must own delivery and retries should invoke the whole pipeline instead (see
[remote steps](./remote-step-composition.md)).

For dependency, failure, and selection behavior, read [core concepts](./concepts.md).
For commands, read [the CLI](./cli.md); for the local run UI,
[the studio](./studio.md). To tie historical runs to a compiled graph and handler
release, set `implementationVersion` as in [tracing](../examples/tracing.ts);
Studio's [definition history](./studio.md#definition-history-and-comparison)
compares observed versions.

## Host Studio privately

Use the [Studio gateway recipe](./studio.md#host-studio-behind-an-application-gateway)
to mount a long-lived CLI process beneath an application's admin URL. Your
application checks login and admin permission on every request and owns
deployment and storage. Use an explicit deployed catalog, keep the backend token
server-only, and never retry an uncertain launch.
