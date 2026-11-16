# Agent guide for `tubeless`

Rules for writing or modifying Tubeless pipelines, CLI scripts, and shared
helpers. Semantics live in the linked guides; examples live in
[`examples/`](../examples). Verify exact names against the
[generated API inventory](./api-reference.md) or the installed declarations; do
not invent APIs.

For consumer projects, install the [agent skill pack](./agent-skills.md).
`tubeless-make-pipeline` converts existing code; `tubeless` supports ongoing
authoring.

## Workflow

1. Open the [recipe index](./recipes.md) and adapt the smallest matching example.
2. Start a project with `tubeless init` (it writes `tubeless.project.ts` and
   `pipelines/import.ts` and never overwrites); do not hand-write the first file.
   Use [the minimal project](../examples/tubeless.project.ts) and
   [the project with custom adapters](../examples/project/tubeless.project.ts) as references.
3. Model data dependencies first, then failure policy, then CLI concerns.
4. Typecheck, run focused tests, then run `make check` after package, docs, or
   example changes.

## Steps and results

- Call `createSteps<TDomainOptions>()` once per pipeline and destructure the
  constructors you use (`step`, `waitForInput`, `fromPipeline`, `fromRemote`,
  `iteratePipeline`, `forEachPipeline`). Call `definePipeline` once afterwards and
  let it infer type arguments; annotate the finalizer's return type for an explicit
  result. Partial explicit generics widen the pipeline ID to `string`.
- Domain options hold business input only. Built-in controls go in
  `run(options, controls?)`; `plan(controls)` takes controls alone. Use
  `run(undefined, controls)` when input is optional. Use `createSteps(optionsSchema)`
  for Standard Schema validation, `outputSchema` only at untrusted step boundaries,
  and `resultSchema` for the public result. Core imports no schema library.
- Give steps stable kebab-case IDs and operational descriptions. `name` is
  presentation only; dependencies, traces, reports, and CLI selection use the ID.
- Use `dependsOn` for required output, `optionalDependsOn` when absence is valid,
  and `skipAfterFailureOf` for a failure gate that supplies no data (it blocks on
  both failed and cancelled prerequisites).
- Add `skip` only for an intentional successful outcome, never to swallow an
  exception. A string or `{ reason }` result makes the output `T | undefined`;
  returning `{ reason, value }` on every skip branch keeps `T`.
- Return values from steps; do not share mutable state between them.
- A pipeline can be `{ id, steps }`: an unfiltered run executes every step and
  the result is the last step's output. `finalize: step` returns that step's exact
  output type and fails when it is missing. Wrap an explicit finalizer in
  `requireOutputs` when a valid result needs specific outputs; never default
  missing required outputs. See [precise result](../examples/precise-result.ts).
- For a static family of similar steps, adapt the tuple helper in
  [parameterized steps](../examples/parameterized-steps.ts) with explicit IDs and
  synchronous expansion; use `forEachPipeline` for runtime items.
- A `PipelineDefinitionError` at module load is an authoring bug.
- Add inert `metadata` (`tags`, `owner`, `domain`, `annotations`) for discovery;
  it never selects execution. See [graph metadata](./graph-metadata.md).

## Selection and plans

- Declare public goals with `targets: [step]` on `definePipeline`. A run selects
  them explicitly and gets their required inputs and failure gates; without
  selection controls every step runs. Omitted definition `targets` exposes the
  last step; `targets: []` exposes none.
- `stepIds` is exact low-level filtering of any step and cannot be combined with
  `targets` (rejected at compile time and at runtime).
- On the CLI these are `--step` and `--target`; `mapOptions`, validation, and hooks
  receive `stepIds` and `targets`. Never redeclare the built-in flags.
- Explain selection with `PipelinePlanStep.selectionReasons`; do not rebuild it
  from dependency arrays. `plan()` is synchronous, never invokes domain schemas or
  handlers, and does not validate domain input.

## Dry runs and side effects

- Set `dryRun: "skip"` on writes, database mutations, publication, email, and any
  step whose normal `run` must not execute; or supply a side-effect-free typed
  `dryRun` handler that returns a preview. Unmarked steps still run in dry runs.
- Dry run is not rollback. Do not publish after failed or cancelled validation:
  make validation required, or gate with `skipAfterFailureOf`.
- Read-only fetches may still contact real systems; use fake I/O in tests.

## Concurrency

- Parallel DAG steps are opt-in: `run(options, { maxConcurrency: 4 })`
  (`--max-concurrency` on commands; default `1`). Declare edges for side-effect
  ordering. Concurrency, fail-fast, and `continueOnError` semantics are in
  [concepts](./concepts.md); see [the parallel DAG recipe](../examples/parallel-dag.ts).
- Child runs and fan-out have their own limits through the child `controls`;
  parent and fan-out limits multiply.
- `runConcurrent`/`runConcurrentPartial` and `runBatched`/`runBatchedPartial`
  (`tubeless/batch`) are for lightweight bounded work without child lifecycle
  events. Branch on `ok`; use `completedIndexes` to separate successful `undefined`
  results from holes.

## Caching and artifacts

- Opt deterministic steps into `cache: { version: "v1" }`, or `cache: true` with a
  pipeline `implementationVersion`. Run with `{ cache: "recompute" }` or
  `{ cache: "bypass" }` (`--cache` on commands); keep it out of domain options.
  Dry runs, skips, and test overrides bypass the cache. The default codec rejects
  lossy round trips such as class instances. See [cache contracts](./step-output-cache.md)
  and [the cache recipe](../examples/step-output-cache.ts).
- Record I/O with `context.recordArtifact({ operation, artifact })` or the
  `loadArtifact`/`saveArtifact` conveniences; savers default to `dryRun: "skip"`.
  Keep metadata bounded and free of secrets, and checkpoint advancement
  application-owned. See [artifacts](./artifacts.md) and
  [artifact lineage](../examples/artifact-lineage.ts).
- For structured test failures use `vitestCheckReport` from `tubeless/node`; store the
  bounded report as an artifact before failing the step. See
  [structured diagnostics](./structured-diagnostics.md).

## Composition

- `fromPipeline` runs one independently useful child; `forEachPipeline` fans out
  at runtime with stable keys and bounded concurrency; `iteratePipeline` repeats a
  child with a required `maxIterations` and `transition` returning `next` or
  `finish`. Omit `fromPipeline.mapOptions` only when the parent's options satisfy
  the child's input. Put child `targets`, `stepIds`, concurrency, failure policy,
  and dry-run opt-in in `controls`, never in `mapOptions`. Use
  `onItemFailure: "stop" | "collect"` for non-default failure handling instead of
  hand-rolling a child loop. See [child composition](./child-pipeline-composition.md)
  and the [child](../examples/child-pipeline.ts),
  [fan-out](../examples/fan-out-partial-results.ts) and
  [pagination](../examples/iteration.ts) examples.
- `fromRemote` needs `adapter`, `mapInput`, and `outputSchema`. The adapter and
  remote worker must honor `context.dryRun`; omitting `dryRun` contacts the engine
  during a dry run. Forward `context.signal` and rethrow remote failures as `Error`
  with `cause`/`code`. For CPU parallelism use `createWorkerThreadAdapter` from
  `tubeless/node` through `fromRemote`; never serialize closures; close the adapter.
  See [remote steps](./remote-step-composition.md).
- Hosting inside an existing engine: [Airflow](./airflow.md),
  [Temporal](./temporal.md), [Inngest](./inngest.md), [Dagster](./dagster.md),
  [Step Functions](./step-functions.md). Call `runOrThrow` inside the host's unit
  of work, pass `correlationId` for joins, and forward cancellation. Host retries
  repeat the whole pipeline; correlation IDs give no persistence or resume.
- For recovery across fresh processes, pass a host-owned `executionJournal` in
  runtime context and follow the [execution journal contract](./execution-journal.md).
  Give every journaled pipeline an explicit `implementationVersion`; keep inputs,
  cwd, effective controls and replayed callbacks compatible. Acknowledged outputs
  restore; incomplete ordinary effects require reconciliation. Only built-in
  composition, input waits and native agent handoff re-enter incomplete work.
  Host input callbacks deduplicate with `executionJournalPath`, not fresh `runId`s.
  Keep this capability separate from `context.checkpoint`, caches and traces.
  Native agents inherit their own journal or use explicit durability before the
  host's `agentStore`; the outer journal is suppressed inside agent work.
  Adapt [host embedding](../examples/host-embedding.ts).

## Projects and commands

- Group pipelines with `defineProject(id, [pipelineA, commandB])` from
  `tubeless/project`. Register each pipeline exactly once, directly or through its
  `definePipelineCommand` entry; duplicate IDs fail and children are not registered
  recursively. Retrieve with `project.get(id)`. Pass `{ name, description }` as the
  third argument; default-export the project for CLI and Studio selection (without a
  default, exactly one distinct project may be exported). Project `cwd` is relative
  to the project file.
- Use `PipelineInput<typeof pipeline>` and `PipelineResult<typeof pipeline>` for
  wrappers, and `PipelineProject` when annotating a function that accepts a project.
- Schema-backed pipelines become CLI and Studio commands automatically. Automatic
  commands need Standard JSON Schema input metadata; schema-less pipelines (even
  with no inputs) need explicit `params`.
- `definePipelineCommand(pipeline)` from `tubeless/cli` adapts a pipeline for
  scripts and Studio; use `defineCommand` for standalone scripts. Use `overrides`
  only for aliases, names, descriptions, or env fallbacks. Explicit `params`
  replaces inference; nested/union inputs and some constraints need it too (see
  [CLI guide](./cli.md)). Omit `mapOptions` only when validated flags already
  match same-name pipeline options. Do not parse `process.argv` manually. See
  [automatic CLI](../examples/automatic-cli.ts).
- `--resume` exists only with managed `checkpoint` configuration or an explicit
  `resume: true` command that handles `values.resume`. Steps read
  `context.checkpoint`; never pass checkpoint paths or stores via domain options.
- Preview with `command.plan()` or `tubeless plan`, not a simulated `--plan`.
  Generate graphs with `toMermaid()` or `tubeless graph`; do not hand-copy edges.
- Keep application flags after `--`: `tubeless run <pipeline-id|file> -- <args>`.
  Use `run --json` for the report and finalized value (stdout; logs go to stderr);
  values must be plain JSON, so use `null` rather than `undefined`. `--trace <path>`
  writes NDJSON, `--store` SQLite; `tubeless history` inspects both. CLI errors
  suggest `Did you mean …?`; apply the hint instead of guessing. Full reference:
  [CLI](./cli.md), [Studio](./studio.md).
- Cloud: `tubeless auth login`, `cloud list`, `cloud run`; headless automation
  injects `TUBELESS_TOKEN` and always passes `--workspace`. Use `--idempotency-key`
  to preserve uncertain admissions. Contract: [Cloud CLI](./cli.md#tubeless-cloud).

## Declarative documents

- Parse YAML/JSON at the application edge, then call
  `compilePipelineDocument(document, registry)` from `tubeless/project` with
  explicitly registered handlers, adapters, predicates, and schemas. A step
  declares exactly one of `run`, `fromPipeline`, or `forEachPipeline`. Use
  `compiled.get(id)` or pass `compiled.pipelines` to `defineProject`; reuse
  `compiled.metadata` for presentation. Handler values are `unknown`; narrow them.
- Validate structure with `tubeless validate --json <document.yaml>` and the
  [document JSON Schema](./pipeline-document.schema.json). For user input register
  `waitForInput(...).run` as a handler. See
  [declarative pipelines](./declarative-pipelines.md) and the
  [YAML recipe](../examples/yaml-pipelines.ts).

## Agents

- `defineAgent({ id, model })` (`tubeless/agent`) with `openaiModel()` or
  `anthropicModel()` is the model-backed agent; `defineAgentLoop` is for custom
  `decide` callbacks. For a typed in-pipeline agent give `defineAgent` an
  `inputSchema`, a `task` mapper, and a `resultSchema`, then compose it with
  `fromPipeline` ([extract recipe](../examples/agent-extract.ts)). Typed agents use
  a task-neutral prompt, so `instructions` is their main guidance.
- Grant autonomous agents only the tools they need with `defaultTools`; all of
  `read`, `write`, `edit`, `bash`, `list`, `search` are granted otherwise.
- Validate every tool input and output. Keep provider calls and credentials in
  application code, forward cancellation, and bound questions and observations.
- Capture content only with an explicit, redacted `transcript`; it is independent of
  `--trace` and `--store`. Code mode (`codemode: true`) is off by default; use it
  only for loops, aggregation, or large tool inventories.
- Chat with `tubeless agent`; keep an agent's default `{ task }`/`{ answer }` schemas
  for it. Use `createAgentSession(agent)` for conversations in your own app.
- Everything else is in [agents](./agents.md) and the `examples/agent-*.ts` recipes
  (MCP, code mode, durability, environments, transcripts, evaluation, providers).
  Use `createAgentTranscriptCollector` and `createAgentTestWorkspace` from
  `tubeless/testing` in evaluations; live paid evals are opt-in (`bun run eval:agent`).

## Cloudflare

- Host Studio and a project with `tubeless init cloudflare` and the
  [deploy guide](./deploy-cloudflare.md); do not hand-write the Worker or its
  configuration. Keep the scaffold's `vite.config.ts` and install the exact versions
  it prints.
- Keep handlers Workers-compatible (no durable filesystem writes, no `v8`
  serialization). Cached steps need an explicit store and codec from
  `tubeless/cloudflare/cache`, never `tubeless/cloudflare`, which loads only in
  workerd.
- One run is aborted at 14 minutes; keep steps short, put long work behind
  `fromRemote`, and use a host engine for longer workflows.
- Application-owned cron or queue launches set an immutable `deploymentId` and call
  `app.launch(env, commandId, values, { idempotencyKey })` with a stable key. A
  receipt confirms admission, not success. Pass a service `actor` and `trigger` for
  attribution; input history saves nothing unless `recordInputs` allowlists
  non-secret parameter keys. See the
  [scheduled Worker example](../examples/cloudflare/scheduled-worker.ts).
- Never put secrets in `cloudflare.config.ts` text bindings. Every user Access
  admits sees all history and commands.

## Runtime rules

- Library entrypoints are ESM-only and need Node.js 22.18+; the `tubeless` CLI
  needs Bun 1.3.14+ on `PATH`.
- Inside steps use `context.log` (never `console`), pass `context.signal` to
  network, retry, and long waits, use `context.sleep` for delays, and call
  `context.reportProgress` and `context.reportAttempt` for long work. Resolve
  relative files from `context.cwd`.
- `tubeless/node` provides `definePaths`, `writeJson`, `readJson`, `resetDir`, and
  `requireEnv`. Mark writes and resets `dryRun: "skip"`; `readJson` does not validate.
- `runOrThrow` for callers that need a value (always throws on an unsuccessful run,
  including `continueOnError`); `run` to inspect failures, skips, and partial
  output. Branch on `run.finalized` before reading `run.value`.
- Branch on `PipelineError.code`, `phase`, and `kind`, never message text;
  original thrown codes are in `sourceCode`. Inspect `error.fanOut` for keyed
  fan-out failures. Standard Schema failures use `kind: "validation"`.
- Use focused hooks (`onStepStart`, `onStepProgress`, `onStepComplete`,
  `onStepSkip`, `onStepCancel`, `onStepFail`); `onStepStatus` only when one
  consumer needs the whole lifecycle. Treat finalized values as read-only.
- Test with `createPipelineTestRuntime` from `tubeless/testing`; supply typed
  intermediate values with `overrideStep(step, value)` and `{ overrides }`.
  Overrides bypass handlers, skips, and dry-run policies for selected steps; select
  them with exact `stepIds` to exclude upstream I/O. See
  [the override recipe](../examples/step-output-overrides.ts).
- Preserve the dependency-free runtime: implement JSON or telemetry adapters at the
  application edge against `PipelineTraceExporter` ([tracing](../examples/tracing.ts)),
  combine with `composeTraceExporters`, and set project
  `tracing: { exporters: (context) => [...] }` for CLI, Studio, and hosted launches.
- Observation is opt-in: `--store` for SQLite, `--trace` for NDJSON, inspected with
  `tubeless history` or `tubeless ui`. Trace files are sensitive and unredacted. Run
  `tubeless upgrade --yes --store <path>` before an unattended job writes to an older
  store. Do not make pipeline definitions depend on storage or Studio. Set
  `implementationVersion` on `definePipeline` to a release/source identity; a
  structural fingerprint alone never proves code equality.
- Studio (`tubeless ui`) launches only checked-in project commands, never modules
  inferred from history. Keep loopback binding locally; for deployed Studio follow
  the [gateway contract](./studio.md#host-studio-behind-an-application-gateway).

## Failure and safety

- Do not use `skip` to swallow an exception.
- Do not treat dry run as rollback.
- Do not publish after failed or cancelled validation.
- Do not hide missing required finalizer outputs behind defaults.
- Keep step IDs stable; reports, hooks, traces, and CLI selection depend on them.

## References

- [Core concepts](./concepts.md): skips, failures, selection, controls.
- [CLI](./cli.md): list, inspect, plan, graph, run, history, exit codes.
- [Studio](./studio.md): before changing `tubeless ui` or command adapters.
- [Child composition](./child-pipeline-composition.md): before changing child propagation or selection.
- [Recipe index](./recipes.md): executable examples to read before writing new usage.

## Validation

```sh
make check
```

For a consumer-only change, run its focused tests and the typecheck. After an
intentional public declaration change, run `bun run api:generate` from the package
root; never edit the generated API artifacts by hand.
