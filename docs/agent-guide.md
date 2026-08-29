# Agent guide for `tubeless`

Use this guide when generating or modifying pipelines, pipeline-backed scripts,
or shared helpers in this repository.

## Workflow

1. Read the [recipe index](./recipes.md) and open the smallest matching example.
2. Copy file layout and stable IDs from the
   [project catalog](../examples/catalog/tubeless.studio.ts).
3. Declare stable IDs and operational descriptions. Add `name` only when printed
   output needs a friendlier display name.
4. Model data dependencies before failure policy or CLI concerns.
5. Typecheck the example or consumer, then run focused tests.
6. Run `make check` from the package root after changing the package or its learning surface.

## Primitive selection

- Use `createSteps<TDomainOptions>()` once per pipeline and `definePipeline` once
  after declaring its steps. Domain option types contain domain input only;
  callers pass built-in controls alongside domain fields to `run(options)`, while
  `plan(controls)` accepts controls alone.
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
- Use `step.skippable` only for an intentional successful outcome. Handle its
  resulting `T | undefined` output type explicitly.
- Use `fromPipeline` for one independently useful child workflow and
  `forEachPipeline` for runtime fan-out with stable keys and bounded concurrency.
  Parent plans keep these steps opaque but expose `nestedPipeline` with the child
  pipeline id, declared step ids, and single/fan-out mode for presentation.
- Use `runConcurrent` for bounded lightweight functions that do not need child
  lifecycle events.
- Use `definePipelineCommand` for scripts centered on a pipeline. Do not parse
  `process.argv` manually or redeclare built-in dry-run, step, or target flags.
  Omit `mapOptions` when validated flags already satisfy same-name pipeline
  options; provide it when names, types, defaults, or derived values differ.
  The returned command exposes an immutable `descriptor`; UI adapters should
  render that structured parameter contract instead of parsing help text.
  Use `command.plan()` or `tubeless plan` for a selection-only preview. Do not
  simulate planning with `--plan`.
- Use `pipeline.toMermaid()` or `command.toMermaid()` when documentation needs
  the static graph; do not duplicate dependency edges by hand.
- Use `tubeless inspect <pipeline-or-command-file>` for a module inventory,
  `tubeless plan` to preview selection without domain options or execution, and
  `tubeless graph` when generating documentation. `inspect`, `plan`, and `graph`
  accept a pipeline or a marked command and prefer the command when both are
  exported. Let the workbench discover the sole matching export or pass
  `--export`.
- Use `tubeless run <command-file> -- <command-args>` only for modules exporting a
  `definePipelineCommand`. Keep application flags after `--`; the command must
  continue to own domain validation and option mapping.

## Runtime rules

- Library entrypoints are ESM-only and require Node.js 22 or later. The
  `tubeless` CLI requires Bun 1.3.14 or later; its `#!/usr/bin/env node`
  trampoline relaunches the binary with Bun under Node and reports an
  actionable install message when Bun is missing.
- Use `context.log`, never direct `console` calls inside steps.
- Pass `context.signal` into network calls, batching, retry, rate limiting, and
  long waits. Use `context.sleep` for retry-aware or testable delays.
- Call `context.reportProgress` for long loops and `context.reportAttempt` for
  retries that operators should see.
- Resolve relative files from `context.cwd`; prefer helpers from
  `tubeless/node`.
- Use `runOrThrow` when every step must succeed and the caller expects a value.
  It always throws for an unsuccessful run, including `continueOnError` runs.
  Use `run` when the caller must inspect failures, skips, timings, or best-effort
  output. Its versioned `PipelineRun` exposes `runId`, terminal status and
  timestamps, errors, and timestamped step reports with correlated attempt IDs;
  structural skips have no attempt ID or start timestamp. Use hooks or tracing
  for streaming logs and progress. Use `plan` when nothing may run.
- Declare supported downstream goals with `targets: [step]` on
  `definePipeline`, then select their literal IDs through run controls. Required
  inputs and failure gates are selected recursively. Use `stepIds` only when
  exact low-level filtering of any step is intentional; never combine the two.
- Read `PipelinePlanStep.selectionReasons` when explaining selection. It already
  includes originating targets and immediate dependents; do not reconstruct
  provenance by walking dependency arrays in application or CLI code. Use
  `renderPipelinePlan` from `tubeless/render` for shared human or JSON output
  instead of maintaining another selection-reason formatter. Use
  `createPipelineReporter` / `createRunReporter` from `tubeless/reporter` for
  TTY presentation; do not import reporters from the root kernel.
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
  original value through native `Error.cause`. Use `renderPipelineError` when a
  diagnostic crosses a human or JSON presentation boundary.
- Standard Schema failures use `kind: "validation"`, retain normalized `issues`,
  and have boundary-specific codes for options, step outputs, and final results.
  Async schemas run during `run`; synchronous `plan()` previews graph and
  selection only and never invokes schemas.
- Wrap normal finalizers in `requireOutputs` when a valid result requires
  specific step outputs. Use a plain finalizer only when partial output is a
  valid domain result.
- Preserve the dependency-free runtime. Keep application telemetry SDKs at the
  exporter boundary.
- Keep durable local observation opt-in. Use the append-only adapter from
  `tubeless/run-store/sqlite` or `tubeless run --store`; do not make pipeline
  definitions depend on storage or the studio.
- Use `createPipelineRunProjector` from `tubeless/run-store` when a custom
  reader pages `listEvents({ afterId })`. Append each newer page and call
  `snapshot()`; a refresh with no new ids returns the cached view. Duplicate
  and out-of-order ids are ignored; `0` is a valid first id. Pass
  `{ retainLogs: false }` only when the snapshot should keep `logCount`
  without log bodies. Use `projectPipelineRunStore` only for a one-shot fold
  of a complete list. See
  [`local-observability.ts`](../examples/local-observability.ts).
- Pass caller-owned `runId` and `parentRunId` values through `PipelineContext`
  when joining an external execution tree. Do not derive correlation from step
  IDs or timestamps.
- Treat `tubeless ui` as a local projection with no execution capability by
  default. Use `definePipelineStudio` for a checked-in command catalog, and
  register only explicit `definePipelineCommand` modules; never make execution
  require the studio server or infer executable modules from observed history.

## Failure and safety rules

- Do not use `step.skippable` to swallow an exception.
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
- Read [the CLI](./cli.md) for inspect, plan, graph, run, and exit codes.
- Read [the studio](./studio.md) before changing `tubeless ui` or
  `definePipelineStudio`.
- Read [child composition](./child-pipeline-composition.md) before changing child
  propagation, progress, or parent/child selection.
- Read the relevant executable example linked from the
  [recipe index](./recipes.md) before writing new usage.
- Copy consumer layout, export names, and IDs from the
  [project catalog](../examples/catalog/tubeless.studio.ts).
- Use the [generated API inventory](./api-reference.md) only to verify exports;
  it is not implementation guidance.

## Validation

For package changes:

```sh
make check
```

For a consumer-only change, run its focused tests and the repository typecheck.
If the public surface changes intentionally, regenerate the checked API artifacts
with `bun run api:generate` from the package root.
