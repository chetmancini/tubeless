---
name: tubeless
description: Author, modify, or review typed Tubeless pipelines, pipeline-backed CLI commands, and projects in TypeScript projects. Use for dependency modeling, failure and skip policies, dry runs, child pipelines, and pipeline tests.
---

# Author Tubeless pipelines

Use the project's installed Tubeless version and public package imports. Keep
domain logic in ordinary functions and make orchestration explicit in the graph.

## Find the matching documentation

Read the consumer's package manifest, installed Tubeless version, and existing
pipeline conventions first. The installed `tubeless` package includes `docs/`
and `examples/`; locate it through the project's package manager. Within the
Tubeless source repository, use those directories at the repository root.

Read `docs/agent-guide.md`, then the smallest matching example in
`docs/recipes.md`. These paths are relative to the **Tubeless package**, not
this installed skill or the consumer's repository. If package docs are absent,
start with the [public documentation index](https://tubeless.io/llms.txt),
[agent guide](https://tubeless.io/docs/agent-guide.md), and
[recipes](https://tubeless.io/docs/recipes.md). Confirm newer examples against
the installed declarations before using them; do not silently upgrade Tubeless.

## Authoring decisions

- Use `createSteps<TDomainOptions>()` per pipeline and destructure every
  constructor it needs: `step`, `fromPipeline`, `fromRemote`, `iteratePipeline`, and/or
  `forEachPipeline`. Domain options contain business inputs; pass built-in
  controls separately to `run(options, controls?)`.
  Use `run()` or `runOrThrow()` when all input fields are optional; omitted input
  becomes a fresh `{}` and still undergoes schema validation. Supply controls with
  `run(undefined, controls)` in that case.
- Use `plan(controls)` to validate static controls and selection without invoking
  domain schemas or handlers. Runs reuse the same control validation.
- Opt in to independent DAG parallelism with `run(options, { maxConcurrency: 4 })`;
  the default is `1`. All dependency edge types wait for terminal prerequisites.
  Declare edges for side-effect ordering; child runs have their own concurrency limit.
  Fail-fast stops dispatch without cancelling active work. External cancellation
  stops dispatch in either error mode and drains active work. Final reports and
  step errors use plan order; hooks and traces use event order.
- For repeated steps known before execution, adapt the recipe-local helper in
  `examples/parameterized-steps.ts`. Use explicit IDs and source step references,
  expand synchronously, then spread the tuple into the ordinary pipeline. Preserve
  each literal ID and the shared output type; do not generalize its tuple assertion
  to factories with varying output types. Use `forEachPipeline` for runtime items.
- Give steps stable kebab-case IDs and descriptions of their domain work.
  `name` is an optional display label. Return values from steps and consume
  inferred dependency outputs instead of sharing mutable state.
- Give a pipeline optional `name` and `description` when CLI and Studio need
  presentation beyond its stable ID. Pipeline commands inherit both fields;
  command-level values are overrides for adapter-specific help.
- Use `dependsOn` for required outputs, `optionalDependsOn` for expected
  absence, and `skipAfterFailureOf` for a failure gate without a required value.
  Keep publication dependent on successful validation.
- Add `skip` to a step definition for an intentional successful omission. A
  string or `{ reason }` result produces `T | undefined`; handle that absence
  explicitly. If every skip branch returns `{ reason, value }`, the output
  remains `T`. Do not turn exceptions into skips.
- Set `dryRun: "skip"` on writes and other external side effects, or supply a
  side-effect-free typed preview handler. Unmarked steps still run in dry runs.
- A `definePipeline` can be `{ id, steps }`: unfiltered runs select every step.
  Explicit run `targets` select only those goals and their required prerequisites.
  Omitted definition `targets` exposes the last step in execution order as a
  selectable goal; it is never selected automatically. Use `targets: []` to expose
  none. Omitted `finalize` returns that last step's output, or `undefined` if absent.
- Use `finalize: step` to require and return one declared step's exact output type.
  Missing outputs fail finalization; a published `undefined` remains valid.
  Targets and selection remain independent. `resultSchema` can validate or transform
  the selected output. See `examples/precise-result.ts`.
- Use `requireOutputs` when the final result requires specific outputs. A plain
  finalizer is appropriate when partial results are valid domain results.
- Use `runOrThrow` for callers expecting a successful value, `run` for callers
  inspecting structured failures or partial results, and `plan(controls)` when
  no work should execute. Branch on `run.finalized` to narrow `run.value` to the
  exact result type; finalization is independent of success, and a finalized
  result may itself be `undefined`. Plans do not validate domain input.
- Use `context.log`, forward `context.signal`, use `context.sleep` for waits,
  and report progress for long loops. Resolve relative paths from `context.cwd`.
- Branch on structured error `code`, `phase`, and `kind`, not message text.
- Group application pipelines with `defineProject(id, [pipelineA, pipelineB])` from
  `tubeless/project`. Retrieve one with `project.get(id)`; it keeps the exact pipeline
  option and result types and uses the pipeline's existing methods directly.
  Register each pipeline exactly once, directly or through its command, for example
  `[pipelineA, commandB]`. Duplicate IDs fail regardless of entry form. Children are
  not registered recursively. The project views are derived immutable snapshots.
  Let `definePipeline` infer its generics; annotate the finalizer's return type
  for an explicit result contract. Partial explicit generics widen the pipeline ID
  to `string`, so project lookup no longer checks literal IDs at compile time.
  Use `PipelineInput<typeof pipeline>` and `PipelineResult<typeof pipeline>` for
  wrapper contracts; the input is the value accepted by `run` before schema
  transformation. `definePipelineCommand` retains the exact pipeline on
  `command.pipeline`.
  Optional `{ name, description }` in the third argument supplies project
  presentation; the name defaults to the ID. For compiled documents, reuse
  `compiled.metadata?.name` and `compiled.metadata?.description`, or spread
  `compiled.metadata` before explicit overrides. Authors/date remain descriptive;
  the project ID and execution cwd belong to registration.

## Add only the capabilities the workflow needs

Read the corresponding package recipe before using these features:

- For YAML or JSON authoring, read `docs/declarative-pipelines.md` and
  `examples/yaml-pipelines.ts`. Use `compilePipelineDocument(document, registry)` from
  `tubeless/project` on parsed data with explicitly registered handlers,
  adapters, skip predicates, and schemas. Each document step declares `run`,
  `fromPipeline`, or `forEachPipeline`; composed pipeline IDs resolve inside
  the document and use the matching adapter registry for application-owned
  option, item, and result mapping. Keep parsing at the application edge. The immutable
  compiled value exposes `pipelines`, throwing `get(id)`, and validated metadata.
  Use a selected pipeline directly, or register selected pipelines with `defineProject`;
  compilation alone does not register children or any other pipelines. Export
  the project for CLI and Studio: Standard JSON Schema input metadata
  enables automatic commands; custom or schema-less inputs need explicit adapters
  in the project's entry list. Handler inputs and pipeline results are
  unknown; validate or narrow them. Plans still do not validate business inputs.
  Use `tubeless validate --json <document.yaml>` for a structure-only check
  without handlers. Fetch `https://tubeless.io/schemas/pipeline-document-v1.schema.json`
  for editor and agent validation, or use packaged `docs/pipeline-document.schema.json`.
  Optional metadata (`name`, `description`, `authors`, `date`) does not affect
  execution; compile and plan to check handler references and graph semantics.

- `fromPipeline` for an independently useful child workflow;
  `forEachPipeline` for runtime fan-out with stable keys and bounded concurrency.
  Omit `fromPipeline.mapOptions` when the parent's validated options satisfy the
  child's input type; it forwards them unchanged through child validation. Fan-out
  still requires explicit per-item mapping. Keep `mapOptions` limited to child
  domain input. Supply child execution controls
  separately through `controls`, either as a typed value or a callback. A child's
  `dryRun: false` never disables a dry-running parent.
  Use ordinary helpers or `runConcurrent` for lightweight work without child
  lifecycle reporting. Use `runConcurrentPartial` from `tubeless/batch` for partial
  results: branch on `ok`, use `completedIndexes` for successful outputs (including
  `undefined`), and read `failure` only when `ok` is false. A rejection may itself
  be `undefined`. Both helpers stop admitting work after failure or cancellation,
  drain active workers, and preserve input-order results without cancelling
  siblings. Invalid concurrency throws rather than returning an execution outcome.
- `iteratePipeline` for bounded repeated child execution. Supply fresh `initialState`,
  `mapOptions`, a positive safe-integer `maxIterations`, and `transition` returning
  `{ kind: "next", state }` or `{ kind: "finish", result }`. State is read-only
  by contract; required dependencies feed initialization/mapping. Static child
  controls remain separate from domain input. Cancellation drains the active child;
  dry-run propagates. Plans show the bounded region, not future execution IDs.
  Read `docs/child-pipeline-composition.md` and `examples/iteration.ts`.
- `createSteps(optionsSchema)`, `outputSchema`, or `resultSchema` for runtime
  validation at untrusted boundaries. Reuse the project's Standard Schema
  implementation; core needs no schema dependency.
- `definePipelineCommand(pipeline)` from `tubeless/cli` for pipeline-backed scripts.
  Start with `examples/automatic-cli.ts`: Standard JSON Schema input metadata on
  the options schema supplies flags automatically. Use `overrides` only for names,
  aliases, descriptions or environment fallbacks. Explicit `params` replaces
  inference for type-only pipelines or custom CLI inputs; `mapOptions` is only
  needed when their shapes differ.
  Built-in `--step` / `--target` flags map to `stepIds` / `targets`. Do not
  redeclare built-in flags. `--resume` is available only with managed
  `checkpoint` configuration or an explicit `resume: true` command whose
  application code handles `values.resume`; unsupported commands reject it and
  omit it from Studio forms. Read `docs/cli.md` for option mapping.
  Export `defineProject(id, pipelines)` from `tubeless.project.ts` to expose
  schema-backed pipelines directly to the CLI and optional Studio. Use
  explicit adapters in the project's entry list for schema-less pipelines,
  even with no inputs: automatic project commands require Standard JSON Schema
  input metadata. Declare custom `params`, `mapOptions`, and display names on
  `definePipelineCommand`; each adapter uses its pipeline's ID. Project `cwd`
  controls CLI/Studio execution relative to the project file. Use `defineCommand`
  for standalone scripts. For compiled documents, create explicit adapters from
  `compiled.get(id)` and register them directly in the entry list.
  Default-export the project to select it for CLI and Studio. Without a default,
  exactly one distinct project may be exported; aliases are allowed.
- Run a schema-backed pipeline file directly with
  `tubeless run ./pipelines/import.ts -- --source rows.txt`. A marked
  `definePipelineCommand` export wins when present; otherwise the file must expose
  one unique pipeline whose Standard JSON Schema input metadata supports inferred
  flags. Use `--export` to select among multiple exports. Schema-less or unsupported
  input shapes still require an explicit command adapter.
- Use `pipelines/<name>.ts` for definitions. Add `scripts/<name>.ts` command
  wrappers only when explicit `params`, `mapOptions`, or presentation overrides
  are needed. Preserve existing consumer conventions.
- Keep storage and Studio optional. Read `docs/studio.md` before adding them;
  read the composition guides before adding child or remote execution.
- Use `context.recordArtifact({ operation, artifact })` within ordinary steps to
  record successful reads, writes, or verified reuse without changing domain outputs.
  Multiple reports support batches; earlier reports survive later failure. Keep
  checkpoint advancement and atomic promotion application-owned. `loadArtifact` and
  `saveArtifact` are conveniences for one read or unconditional write: both return
  `{ value, artifact }` and publish the typed value. Savers skip dry runs by default;
  loaders that populate caches also need a safe dry-run policy. Forward cancellation
  into adapters. Metadata must be bounded plain JSON with `id` or `uri`; omit secrets.
  See `docs/artifacts.md` and `examples/artifact-lineage.ts`.
- Use `tubeless/node` for cwd-relative path factories, JSON artifacts, required
  environment values and checkpoints. Call `definePaths` factories with
  `context.cwd`; keep `writeJson` and `resetDir` inside dry-run-safe steps.
  `readJson<T>` parses but does not validate untrusted data. See `docs/recipes.md`.
- For Node CPU parallelism, use `createWorkerThreadAdapter` from `tubeless/node`
  through `fromRemote` with an explicit module export and cloneable input.
  Keep output validation on the parent step. A shared adapter bounds worker threads;
  the pipeline still needs `maxConcurrency` to admit parallel steps. Call `close()`
  after all callers finish; cancellation can terminate unresponsive workers.
  See `examples/worker-threads.ts` and `docs/remote-step-composition.md`.
- Implement concrete JSON or telemetry adapters in the application against
  `PipelineTraceExporter`; adapt the package's `examples/tracing.ts`. Use
  `composeTraceExporters` for multiple trace destinations. Finished traces
  can be read with `tubeless history --trace` or `tubeless ui --trace`; recorded
  contents are not redacted.

## Verify

Typecheck the consumer and run focused tests. Use `createPipelineTestRuntime`
from `tubeless/testing` for deterministic observation and cancellation, with
fake I/O for side effects. Supply intermediate values with `overrideStep(step, value)`
and test-run `{ overrides: [...] }` controls. Overrides validate through `outputSchema`
and use normal lifecycle states and hooks with `outputSource: "override"` metadata,
including failed or cancelled validation attempts. Their normal, skip, dry-run, child,
and remote handlers never execute. Select overridden steps explicitly when using exact `stepIds`, and exclude
upstream steps to avoid their I/O. See `examples/step-output-overrides.ts` and
`docs/concepts.md` for selection and failure semantics. Check failure gates, skipped
outputs, and dry-run behavior. Generate diagrams with `pipeline.toMermaid()` when useful.

Within the Tubeless source repository, also follow its `AGENTS.md` and run
`make check`.
