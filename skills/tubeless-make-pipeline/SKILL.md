---
name: tubeless-make-pipeline
description: Convert existing TypeScript or JavaScript scripts, jobs, service workflows, or ETL code into thoughtfully structured, typed Tubeless pipelines. Use when asked to extract a pipeline from existing code, replace ad hoc orchestration, or organize a large workflow into typed steps while preserving behavior.
---

# Make a Tubeless pipeline from existing code

Implement the conversion in the user's project. Preserve observable behavior and
reuse domain functions while making data flow, ordering, and failure policy
visible in a typed graph.

## Ground the design in the existing code

Read the entrypoint, its callers, relevant helpers, tests, and package manifest.
Trace inputs, outputs, external effects, error handling, retries, cancellation,
and any shared mutable state. Identify ordering requirements that are currently
implicit, such as validation before publication or writes inside a transaction.
Preserve transaction boundaries, cleanup, and resource ownership when splitting
work. A transaction or critical section can remain inside one step.

Identify the installed Tubeless version. Read `docs/agent-guide.md` and the
smallest matching `docs/recipes.md` example from that installed package, or from
the package root when working in Tubeless itself. These are package paths, not
paths relative to this skill. If unavailable, use the
[agent guide](https://tubeless.io/docs/agent-guide.md) and
[recipe index](https://tubeless.io/docs/recipes.md), checking APIs against the
installed declarations. If Tubeless is missing, add it using the project's
package manager and dependency conventions. Avoid unrelated upgrades.

Before editing, briefly explain the proposed steps, their inputs and outputs,
and which steps can write externally. Resolve uncertainties from code and tests;
ask only when a missing domain decision affects correctness.

## Choose meaningful boundaries

Create steps around domain outcomes an operator would recognize: load records,
validate a batch, enrich records, build an artifact, publish it. A useful step
has a coherent output and a reason to appear in a plan or failure report.

- Keep small parsing, formatting, and mapping functions as helpers inside a
  step. Do not make every function call a step or hide the entire old script in
  one step when it contains distinct stages.
- Build dependencies from consumed values and required ordering. Do not rely
  on declaration order. Keep independent work independent, but preserve the
  original concurrency, rate limits, and ordering unless a change is intended.
- Use `dependsOn` when a value or successful prerequisite is required. Use
  `optionalDependsOn` only when absence is a valid case. Use
  `skipAfterFailureOf` when a failed or cancelled prerequisite must block work
  without requiring its output. Optional input alone is not a failure gate.
- Replace shared mutable accumulators with returned step outputs. Reuse
  domain types and helpers; avoid a generic bag of optional fields passed
  through every step.
- Extract a child pipeline only when that workflow is independently useful.
  Choose `forEachPipeline` for per-item lifecycle reporting; use bounded helper
  concurrency when that reporting is unnecessary. Read the matching recipe
  before introducing either.

## Keep the graph typed

Use one `createSteps<TDomainOptions>()` builder and one `definePipeline` per
pipeline. Import from `tubeless` and its public subpaths. Keep business inputs
in domain options; built-in run controls belong in the separate controls argument.

Give each step a stable literal kebab-case ID and an operational description.
Let `dependsOn: [step]` infer input types from returned outputs. Preserve
inference in step collections; do not widen IDs to `string` or use `any`, broad
records, or type assertions to bypass graph errors. Add explicit output types
where they define a domain contract, rather than annotating every intermediate.

Parse untrusted inputs as `unknown` and validate at the boundary with existing
project validators. Use Standard Schema support when it fits existing schemas;
TypeScript alone does not validate external data.

Use `requireOutputs` for a result that requires completed steps. If dry runs,
intentional skips, or best-effort execution legitimately produce partial
results, model that result explicitly and narrow missing values. Do not default
a missing required output to an empty array, `false`, or a fake success value.

## Preserve operational behavior

- Mark filesystem writes, database mutations, publication, and other external
  side effects with `dryRun: "skip"` or a typed, side-effect-free `dryRun`
  handler. Unmarked steps still execute in a dry run. Read-only fetches may
  still contact real systems; use fake I/O during verification.
- Follow skipped values through downstream steps and the finalizer. A skipped
  write may prevent `requireOutputs` from producing a result. Either preserve
  that contract or define an honest preview result; never fabricate a completed
  write to make dry runs pass.
- Keep validation required for publication. Test this even with
  `continueOnError` if the caller enables best-effort execution.
- Use `step.skippable` only for a successful policy decision. Preserve thrown
  failures and their causes; branch on structured Tubeless error fields.
  Map pipeline errors at the caller boundary if existing callers require a
  specific error contract.
- Use `context.log` inside steps. Pass `context.signal` to I/O and retry helpers,
  use `context.sleep` for waits, and report progress for long loops. Preserve
  existing retry scope and idempotency; do not add retries to unsafe mutations.
- Keep pipeline imports free of execution and external effects. Leave invocation
  in the existing caller or a thin command wrapper. Retain externally used
  function signatures and return shapes unless the user requests changing them.
- Use `runOrThrow(options, controls?)` for value-or-error callers and `run` for
  explicit report handling. `continueOnError` does not make `runOrThrow` succeed
  after failures. Keep cleanup in a reliable `finally` or resource scope.

Respect the project's layout. If it has no convention, use
`pipelines/<name>.ts` and export `<Name>Pipeline`. Add a
`definePipelineCommand` wrapper only for a CLI workflow, following the CLI
recipe; register it in an existing project catalog when appropriate. Keep
storage, Studio, telemetry exporters, and remote engines optional.

## Prove the conversion

Typecheck and run the project's focused tests. Adapt existing tests to compare
observable behavior, not just graph shape. Cover relevant success, validation
failure, dependency failure, intentional skip, cancellation, and dry-run paths.
Use `createPipelineTestRuntime` from `tubeless/testing` with fake I/O, and assert
that forbidden writes never happen. Avoid executing production work as a test.

Inspect `pipeline.plan()` and, for declared goals, target selection. Planning
does not execute steps or validate domain inputs; it cannot prove runtime
correctness. Generate a graph with `pipeline.toMermaid()` when it helps explain
the design. Within the Tubeless source repository, also run `make check`.

Finish with the implemented step structure, preserved or intentionally changed
behavior, validation results, and any unresolved contract decisions. Remove
superseded orchestration once callers use the pipeline; keep reusable helpers.
