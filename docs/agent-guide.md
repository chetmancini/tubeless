# Agent guide for `tubeless`

Use this guide when writing or modifying Tubeless pipelines, CLI scripts, or
shared helpers. It summarizes the implementation rules; the linked guides and
examples explain each feature.

For consumer projects, install the [agent skill pack](./agent-skills.md).
Use `tubeless-make-pipeline` to convert existing code: check caller inputs and results,
choose domain step boundaries, preserve types and failure behavior, and verify
dry runs with fake I/O. The general `tubeless` skill supports ongoing authoring.

## Workflow

1. Read the [recipe index](./recipes.md) and open the smallest matching example.
2. Use the [project manifest](../examples/catalog/tubeless.project.ts) as a layout
   example. Keep existing project IDs; choose descriptive IDs for new commands.
3. Declare stable IDs and operational descriptions. Add `name` only when printed
   output needs a friendlier display name.
4. Model data dependencies before failure policy or CLI concerns.
5. Typecheck the example or consumer, then run focused tests.
6. Run `make check` from the package root after changing the package, documentation, or examples.

## Choose pipeline features

- For YAML or JSON authoring, read [declarative pipelines](./declarative-pipelines.md)
  and adapt [the YAML recipe](../examples/yaml-pipelines.ts). Parse at the
  application edge, then use `compilePipelineDocument` from `tubeless/project`
  with explicitly registered handlers, adapters, predicates, and schemas. A
  step declares exactly one of `run`, `fromPipeline`, or `forEachPipeline`;
  child pipeline IDs resolve within the document, while application code owns
  option, item, and result mapping through the matching adapter registry. Keep command registration
  explicit for CLI and Studio. Unknown fields and references fail compilation;
  plans still do not validate domain inputs. Dynamic wiring does not infer
  TypeScript output types, so validate or narrow unknown values in handlers.
  Use [YAML Peloton](../examples/yaml-peloton.ts) for a larger example with
  progress, retrying concurrent handlers, dry-run policies, and failure gates.
  Its per-rider progress is ordinary step detail by choice; the smaller YAML
  recipe demonstrates child-pipeline fan-out.
  Use `tubeless validate --json <document.yaml>` for a handler-free structure
  check, and the [document JSON Schema](./pipeline-document.schema.json) for
  editor or agent validation. Optional document metadata is descriptive only.
  `inspect` or `plan` on a compiled command still checks graph semantics.

- Use `createSteps<TDomainOptions>()` once per pipeline and destructure every
  constructor that pipeline uses: `step`, `fromPipeline`, `fromRemote`, and/or
  `forEachPipeline`. Use `definePipeline` once after declaring the steps. Domain
  option types contain domain input only;
  callers pass those options and optional built-in controls to
  `run(options, controls?)`, while `plan(controls)` accepts controls alone.
- Treat a `PipelineDefinitionError` during module loading as an authoring bug;
  static graph mistakes are rejected when `definePipeline` is called.
- Use `dependsOn` when the output is required, `optionalDependsOn` when absence
  is expected, and `skipAfterFailureOf` for a failure gate that supplies no data.
- Use `createSteps(optionsSchema)` when external domain options need Standard
  Schema validation or transformation. Add `outputSchema` only at step
  boundaries that receive untrusted or independently checked values, and
  `resultSchema` when the finalized public result must be checked. Core imports
  no schema library.
- Set `dryRun: "skip"` on filesystem writes, database mutations, publication,
  email, and other steps whose normal `run` must not execute in a dry run. Use a
  typed `dryRun` handler when the step should produce a preview value instead.
- Add `skip` to a step definition only for an intentional successful outcome.
  Handle its resulting `T | undefined` output type explicitly.
- Use `fromPipeline` for one independently useful child workflow and
  `forEachPipeline` for runtime fan-out with stable keys and bounded concurrency.
  Add `skip` only when the whole fan-out may be intentionally omitted; handle
  its `readonly T[] | undefined` output explicitly.
  Async `fromPipeline` result mappings publish resolved values; use that resolved
  shape for dependent inputs and policy-skip values.
  Parent plans show one wrapper step and expose `nestedPipeline` with the child
  pipeline id, declared step ids, and single/fan-out mode for presentation.
  The interactive CLI automatically expands selected child steps and fan-out
  items into nested progress rows and retains completed states. Inner progress
  counts and details propagate through both adapters; do not forward raw child
  hooks or duplicate this bookkeeping in consumers. Fan-out progress displays up to
  32 live item groups by default and emit the full retained tree once at completion.
  Set `progress.detailLimit` to override that live cap and cap the final snapshot.
- Use `fromRemote` for a unit of work that lives on another engine. Required
  fields are `adapter`, `mapInput`, and `outputSchema`. Omitting `dryRun`
  contacts the engine during a pipeline dry run; the adapter and remote
  worker must honor `context.dryRun` and include that flag in the
  request built by `mapInput`. Call `pipeline.runOrThrow` from a worker or activity handler and pass
  `correlationId` when an external system owns job delivery and retries. Pass
  `parentRunId` only when linking to a known Tubeless execution. Parent
  plans expose `remote` with `engine` and optional `target`. Adapters may
  forward remote lines through `context.log` and must rethrow remote
  failures as `Error` with `cause` / `code`. Follow the native-fetch example in
  [`remote-steps.ts`](../examples/remote-steps.ts), including validation of
  unknown JSON and forwarding the signal. Use
  [`host-embedding.ts`](../examples/host-embedding.ts) for host-owned invocation;
  correlation IDs do not provide persistence or checkpoint/resume.
- Use `runConcurrent` for bounded lightweight functions that do not need child
  lifecycle events. Use `runConcurrentSettled` when the caller needs completed
  results and the first failure instead of a throw.
- Use `definePipelineCommand` from `tubeless/cli` for scripts centered on
  a pipeline. Do not parse `process.argv` manually or redeclare built-in dry-run,
  `--step`, or `--target` flags. `mapOptions`, validation, and hooks receive `stepIds` and `targets`,
  not `step` or `target`. Omit `mapOptions` when validated flags already satisfy
  same-name pipeline options; provide it when names, types, defaults, or derived
  values differ.
  The returned command exposes an immutable `descriptor`; UI adapters should
  render those parameter definitions instead of parsing help text.
  Use `command.plan()` or `tubeless plan` for a selection-only preview. Do not
  simulate planning with `--plan`.
- Use `defineCommand` from `tubeless/cli` for standalone scripts. Declare command
  catalogs with `definePipelineProject` from `tubeless/project`; the catalog
  works with the CLI before Studio is added. Keep application-specific prompts
  in the consumer.
- Use `pipeline.toMermaid()` or `command.toMermaid()` when documentation needs
  the static graph; do not duplicate dependency edges by hand.
- Use `tubeless list` for the explicit project command inventory. Use
  `tubeless inspect <registered-id>` for a registered module inventory,
  `tubeless plan` to preview selection without domain options or execution, and
  `tubeless graph` when generating documentation. `inspect`, `plan`, and `graph`
  accept a pipeline or a marked command and prefer the command when both are
  exported. Let the workbench discover the sole matching export or pass
  `--export`.
- Use `tubeless run <registered-id> -- <command-args>` for project commands, or
  the existing file form only for modules exporting a
  `definePipelineCommand`. Keep application flags after `--`; the command must
  continue to own domain validation and option mapping. Pass `--trace <path>` for
  NDJSON traces (`-` writes NDJSON to stdout and moves command output to stderr)
  and `--store` for SQLite; they compose. Use `tubeless history` to list or show
  recorded runs from SQLite, or pass `--trace` to inspect a finished NDJSON
  artifact without importing it.
  Filter shared history with `--pipeline <recorded-pipeline-id>` in any output
  mode. This is the pipeline definition's ID, not its registered command ID.

## Runtime rules

- Library entrypoints are ESM-only and require Node.js 22 or later. The
  `tubeless` CLI uses a `#!/usr/bin/env bun` entrypoint and requires Bun 1.3.14
  or later on `PATH`.
- Use `context.log`, never direct `console` calls inside steps. Wide interactive
  terminals show recent logs beside progress automatically (120 columns by
  8 rows minimum). Set command `reporter.logPane` to `"off"` to disable the pane;
  logs appear only in the pane while it is visible. Use `--trace` or `--store`
  for complete recordings. Forward subprocess output through `context.log`
  when it should appear there. See [the live TUI recipe](../examples/live-tui.ts).
- Pass `context.signal` into network calls, batching, retry, rate limiting, and
  long waits. Use `context.sleep` for retry-aware or testable delays.
- Call `context.reportProgress` for long loops and `context.reportAttempt` for
  retries that operators should see.
- Resolve relative files from `context.cwd` with `node:path`.
- Import optional Node helpers from `tubeless/node`: `definePaths` resolves named
  paths against each run's `context.cwd`; `writeJson` creates parents and atomically
  replaces JSON files, rejecting unserializable top-level values before touching
  disk; `readJson<T>` parses trusted JSON without schema validation;
  `resetDir` deletes and recreates generated output directories; `requireEnv`
  checks required environment values when called. Mark writes and resets with
  `dryRun: "skip"`; these helpers do not inspect pipeline controls themselves.
- Use `runOrThrow` when every step must succeed and the caller expects a value.
  It always throws for an unsuccessful run, including `continueOnError` runs.
  Use `run` when the caller must inspect failures, skips, timings, or best-effort
  output. Its versioned `PipelineRun` exposes its unique `runId`, optional
  reusable `correlationId`, terminal status and
  timestamps, errors, and timestamped step reports with correlated attempt IDs;
  structural skips have no attempt ID or start timestamp. Use hooks or tracing
  for streaming logs and progress. Exporter failures warn once per emitter and
  do not fail the run; pass `onExporterError` to observe the first drop. Use
  `plan` when nothing may run.
- Declare supported downstream goals with `targets: [step]` on
  `definePipeline`, then select their literal IDs through run controls. Omitted
  `targets` exposes the last step in execution order; `targets: []` exposes none. Required
  inputs and failure gates are selected recursively. Use `stepIds` only when
  exact low-level filtering of any step is intentional; never combine the two.
- Read `PipelinePlanStep.selectionReasons` when explaining selection. It already
  includes originating targets and immediate dependents; do not reconstruct
  selection reasons by walking dependency arrays in application code. The
  workbench owns terminal plan formatting and reporting.
- Use focused hooks for ordinary observation: `onStepStart`,
  `onStepProgress`, `onStepComplete`, `onStepSkip`, `onStepCancel`, and
  `onStepFail`. Their event metadata is already narrowed. Use additive
  `onStepStatus` only when one consumer genuinely needs the whole discriminated
  lifecycle, such as a status-aware renderer or event store.
- Use `createPipelineTestRuntime` from `tubeless/testing` for deterministic
  pipeline tests. Inspect its structured logs, statuses, and latest progress;
  keep test-framework matchers outside the package.
- Branch on `PipelineError.code`, `phase`, and `kind`, never message prose.
  Underlying thrown codes live in `sourceCode`. Failed and cancelled reports
  expose the structured error under `error`; skipped reports expose `reason`,
  optional `message`, and optional `dependencyId`. `PipelineError.cause` is a
  bounded JSON-safe snapshot; a thrown `PipelineExecutionError` retains the
  original value through native `Error.cause`.
- Inspect `error.fanOut` in reports or recorded trace history for bounded keyed failures from `forEachPipeline`. Check
  `omittedFailureCount` and `keyTruncated` before selecting rerun inputs; unstarted
  items are not failures. The caller starts a new run for any retry.
- Standard Schema failures use `kind: "validation"`, retain normalized `issues`,
  and have separate codes for options, step outputs, and final results.
  Async schemas run during `run`; synchronous `plan()` previews graph and
  selection only and never invokes schemas.
- A single-goal pipeline can be `{ id, steps }`. Omit `finalize` to return the
  output of the last step in execution order, or `undefined` if absent. Defaults use
  the full graph's topological order and do not limit an unfiltered run. `resultSchema` still
  validates the value, including absent output. See the
  [minimal recipe](../examples/minimal-pipeline.ts).
- Wrap explicit finalizers in `requireOutputs` when a valid result requires
  specific step outputs. Use a plain finalizer only when partial output is a
  valid domain result.
- Preserve the dependency-free runtime. Implement concrete JSON or telemetry SDK
  adapters at the application edge against `PipelineTraceExporter`; see the
  [tracing recipe](../examples/tracing.ts). Use `composeTraceExporters` from `tubeless/tracing` when
  one run must fan out to multiple destinations; `onExporterError` reports the
  first partial drop, the failed destination is retired, and healthy exporters
  keep receiving events.
- Keep durable local observation opt-in. Use `tubeless run --store` for SQLite
  history and `tubeless run --trace` for portable NDJSON traces. Inspect them
  with `tubeless history` or `tubeless ui`. Treat trace files as sensitive: logs,
  errors, and event payloads are displayed as recorded, and malformed or oversized
  artifacts are rejected. `tubeless history` inspects a finished artifact and
  refuses a store with a live writer or multiple hard links. A crash can lose
  buffered events from a live writer; `tubeless run --store` flushes at
  completion so finished runs are durable. Do not make pipeline
  definitions depend on storage or the studio. Version 2 trace events are a
  discriminated union keyed by `name`; use their typed `payload` rather than
  parsing scalar attributes. Recorded history keeps the last `reportProgress` `details`
  plus `detailCount`, and child wrapper steps keep `nestedPipeline` with the
  original `stepCount`. Studio renders those
  snapshots; it does not flatten child DAGs into the parent step.
  Observed definitions pick the latest `pipeline.started` by `timestampMs`, then
  store-local id. Storage readers, projections, and Studio embedding are
  workbench internals rather than application extension points.
  The version 2 event and NDJSON formats remain compatible with saved recordings;
  concrete exporter entrypoints are not part of that durability contract.
- Pass caller-owned `correlationId` through `PipelineContext` when joining an
  external job or workflow. `runId` is package-generated for every execution;
  pass a known execution `runId` as `parentRunId` only to link that parent.
- Use `tubeless ui` to inspect local recordings. Browser execution requires
  explicitly registered commands. Use `definePipelineProject` for a checked-in command catalog with
  stable registered IDs, and register only explicit `definePipelineCommand`
  modules; never make execution require the studio server or infer executable
  modules from observed history.
  Keep the default loopback binding; Studio's internal HTTP protocol is not an
  application API. Cancel a live top-level launch from the running detail pane;
  that abort is process-local, leaves sibling launches running, and is not
  crash-resume.

## Failure and safety rules

- Do not use `skip` to swallow an exception.
- Do not treat dry run as rollback; external side effects require
  `dryRun: "skip"` or a side-effect-free custom `dryRun` handler.
- Do not publish after a failed or cancelled validation step. Make validation
  required, or use `skipAfterFailureOf` when its output is intentionally optional;
  the gate blocks both unsuccessful terminal statuses.
- Do not hide absent required finalizer outputs behind defaults. Declare them
  with `requireOutputs`; handle optional outputs explicitly.
- Keep step IDs stable because reports, hooks, traces, and CLI selection use them.
- Treat `name` as presentation only. Dependencies, outputs, traces, and CLI
  selection continue to use the stable step ID.

## Required references

- Read [core concepts](./concepts.md) for skip, failure, or selection changes.
- Read [the CLI](./cli.md) for list, inspect, plan, graph, run, history, and exit codes.
- Read [the studio](./studio.md) before changing `tubeless ui` or
  `definePipelineProject`.
- Read [child composition](./child-pipeline-composition.md) before changing child
  propagation, progress, or parent/child selection.
- Read the relevant executable example linked from the
  [recipe index](./recipes.md) before writing new usage.
- Adapt consumer layout and export names from the
  [project manifest](../examples/catalog/tubeless.project.ts).
- Use the [generated API inventory](./api-reference.md) only to verify exports;
  it is not implementation guidance.

## Validation

For package changes:

```sh
make check
```

For a consumer-only change, run its focused tests and the repository typecheck.
If public declarations change intentionally, regenerate the checked API artifacts
with `bun run api:generate` from the package root.
