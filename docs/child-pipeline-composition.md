# Child-pipeline composition

## What ships

Compose a child pipeline as one typed parent step with
`createSteps<TOptions>().fromPipeline(...)`. Overloads cover identity and
mapped results. Child lifecycle hooks stay isolated, and child work reports
through parent-step progress without changing the pipeline run loop or
reporter contracts.

Map a runtime item list onto the same child pipeline with
`createSteps<TOptions>().forEachPipeline(...)`. Item keys are stable,
concurrency is bounded, and results keep input order even when children
finish out of order. All running children settle before an aggregate failure
is returned, so the parent cannot finalize while child side effects are still
in flight.

Opaque parent steps pass outputs through typed dependencies, skip side
effects in dry-run, and convert domain validation errors into failed parent
steps.

## Why not call the child from an ordinary step

Invoking a child pipeline from an ordinary parent step and passing the parent
`PipelineStepContext` gives the child the parent's runtime seams, but it also
gives the child the parent's raw hooks and parent-only `reportProgress`
callback.

The resulting lifecycle stream is flat. A direct nested run emits the child pipeline, step, finalize, and completion events between the parent wrapper step's start and completion events. Most events have no pipeline path or run identity. The interactive reporter also owns one plan, one step map, and one result. A child start replaces its visible plan, and a child completion disposes the reporter before the parent completes.

The package needs a composition contract that preserves typing and runtime behavior without exposing two pipeline frames through hooks designed for one pipeline.

## Goals

- Model a child pipeline as one typed step in the parent DAG.
- Infer parent dependency inputs, parent options, child options, the child result, and any mapped result.
- Preserve cancellation, logging, timing, working-directory, dry-run, progress, and failure behavior.
- Keep raw child lifecycle hooks inside the adapter while reporting useful progress through the opaque parent step.
- Keep the first slice bounded: one opaque child, or a mapped set of the same child.

## Supported: policy skip on opaque steps

Policy skip (`step.skippable` / `StepSkipDecision`) is part of the shipped API and
applies to ordinary steps and to `fromPipeline` adapters (the opaque parent
step is a normal step under the hood):

- Return a non-empty string or `{ reason, value? }` from `skip` to skip without
  calling `run` (or without running the child). Reporters show a yellow skip
  whose terminal report has `status: "skipped"` and `reason: "policy"`.
- Policy skips unlock required dependents. A bare string (or `{ reason }`
  without `value`) publishes `undefined` as the step output.
- Any step that declares `skip` is typed so dependents see `TOut | undefined`
  (including `PipelineResultOf<Child> | undefined` for `fromPipeline` without
  `mapResult`). Prefer `{ reason, value }` on every skip path when dependents
  need a real output. With `mapResult`, skip `value` is the parent-facing
  mapped `TOut` — policy skip does not call `mapResult`.

A `fromPipeline.skippable` step can policy-skip optional work and publish a
concrete disabled result via `{ reason, value }`.

`forEachPipeline` does not accept `skip` today; gate mapped fan-out with an
upstream step or filter `items` instead.

## Non-goals

- Flatten child steps into the parent plan.
- Add hierarchical or versioned external lifecycle events.
- Support namespaced selection such as `parent.child-step`.
- Add parallel DAG execution, remote checkpoints, or subcommands.
- Injected runner overrides (substituting a child pipeline implementation at
  test time via parent options) — separate from policy skip.

## Why this shape

| Model                                     | Typing                                                                                                                                                           | Planning                                                                                                      | Hooks and reporting                                                                                                                                | Selective execution                                                                                              | Failure                                                                                                                  | Dry run                                                                                              | Cost                                                                                             |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Continue manual shared-context calls      | Each wrapper can map options and return a typed value, but each wrapper repeats the contract and structural context passing makes unsafe fields easy to forward. | The parent sees only the wrapper step; the child creates a separate plan at runtime.                          | Raw child events enter the parent's flat hook stream. The current interactive reporter replaces the parent frame and disposes on child completion. | Parent selection can select the wrapper. Child selection depends on ad hoc mapped `stepIds`.                     | `runOrThrow` can fail the wrapper, but consistent child-identifying messages and progress require repeated wrapper code. | Each wrapper must remember parent/child dry-run precedence and per-step policy.                      | Low per call, with continuing duplication and reporter breakage.                                 |
| Flatten the child DAG into the parent DAG | The API must translate child option and dependency types into a parent definition without losing inference.                                                      | Child ids need stable namespacing, and runtime option mapping can change which child plan is valid.           | A flat plan fits current hooks only after defining pipeline identity, paths, and collision rules.                                                  | Namespaced filters need semantics for parent dependencies, child dependencies, and finalization.                 | The parent must define how child failures, partial outputs, and child finalization affect the flattened DAG.             | The parent must reconcile its dry-run rules with every flattened child step.                         | High. It requires event identity and selection semantics before the first useful slice.          |
| Opaque typed child-step adapter           | A parent-scoped factory can infer dependency inputs and parent options while a typed child pipeline constrains mapped options and results.                       | The parent plan contains one stable step. The adapter validates the child plan immediately before running it. | Parent hooks see the opaque step only. An internal bridge translates child terminal events into parent-step progress.                              | Selecting the opaque parent step runs the child according to mapped child options. Nested selection is deferred. | An unusable child result throws a parent-step error that retains the child pipeline and failing step identity.           | Framework-owned parent `dryRun` overrides the mapper, then the child applies its own per-step rules. | Medium. It uses existing pipeline and hook primitives without changing the external event model. |

Shared raw hooks are rejected because they already corrupt the interactive reporter's single frame and cannot distinguish nested runs. Immediate flattening is rejected because it needs stable identity, selection, dependency, failure, and finalization rules that the current event and plan models don't provide. The opaque adapter addresses the existing composition case without deciding those broader contracts.

## Contract

The parent DAG contains one ordinary step. That step maps its typed parent inputs and context into typed child options, validates the child plan, runs the child with an isolated internal hook bridge, and returns either the child result or a mapped parent result.

The bridge owns child lifecycle events. Parent and custom hooks receive only the parent pipeline and opaque parent-step events. The bridge reports terminal child-step counts through the parent step's `reportProgress`, so existing reporters keep one live frame.

## API

The parent-scoped step factory owns the adapter:

```ts
const seedIndexStage = step.fromPipeline("seed-index", {
  pipeline: IndexSeedPipeline,
  dependsOn: [seedCatalogStage],
  description: "Seed a precomputed search index",
  mapOptions: (_inputs, context) => ({
    indexDir: context.options.indexDir,
    syncSchema: false,
  }),
  mapResult: () => ({ ran: true, stageId: "seed-index" }),
});
```

`StepFactory.fromPipeline` and `StepFactory.fromPipeline.skippable` infer the
child result when `mapResult` is absent, and infer the mapped result when it
is present.

For runtime-selected sets (any domain — shards, files, jobs, catalog rows):

```ts
const processShards = step.forEachPipeline("process-shards", {
  pipeline: ShardPipeline,
  dependsOn: [resolveShards],
  items: ({ "resolve-shards": shards }) => shards,
  key: (shard) => shard.id,
  concurrency: (_inputs, context) => context.options.concurrency,
  // Optional presentation only. Defaults to the noun "items".
  progress: { itemNoun: "shards" },
  mapOptions: (shard, _index, _inputs, context) => ({
    shardPath: shard.path,
    outputRoot: context.options.outputRoot,
  }),
});
```

The parent sees one opaque `process-shards` step. Progress is domain-neutral by
default: a one-line item/concurrency summary plus structured `details` rows for
each in-flight child (`id` + `label`). Interactive reporters render those as
indented lines under the parent step so high concurrency stays readable. The
progress bar advances on terminal child steps so long fan-out work does not look
hung at 0%. Override `progress.itemNoun` or `progress.formatMessage` for domain
labels without changing scheduling. Duplicate keys fail before any child starts.
Parent dry-run overrides the mapped child run object's `dryRun` value.

## Semantics matrix

| Concern             | Contract                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Parent plan         | The child is one opaque parent step. Its `nestedPipeline` metadata identifies the child pipeline, declared child step ids, and single/fan-out mode; child steps are not added to `PipelinePlan.steps` and runtime selection is not predicted.                                                                                                                                                                                                                                                                                                                                                                            |
| Option mapping      | `mapOptions(inputs, parentContext)` returns the child's complete run object: domain fields plus any child-specific controls. The adapter applies parent `dryRun` last so framework semantics win.                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Other run controls  | The adapter does not automatically propagate parent `stepIds`, `targets`, or `continueOnError`. `mapOptions` may choose child-specific values; child `targets` are limited to that child's declared public goals. Mapping parent selection would usually be invalid because parent and child ids occupy different namespaces. Mapping `continueOnError` lets independent child work finish but does not make a failed child usable by the parent.                                                                                                                                                                        |
| Runtime context     | The adapter forwards `cwd`, `log`, `now`, `sleep`, and `signal` field by field. It does not forward parent hooks or the parent-only `reportProgress` field.                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Hook isolation      | Parent and custom hooks see only the parent pipeline and opaque parent step. Raw child lifecycle events go only to an internal bridge.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Progress            | Single-child `fromPipeline` bridges terminal child steps into the opaque step (`completed` / plan step count, messages prefixed with `childPipelineId/childStepId`). Mapped `forEachPipeline` reports domain-neutral fan-out progress via `toMappedChildStepProgress`: `completed` counts terminal child steps across items, `total` is `items × stepsPerItem`, `message` is a one-line summary, and `details` lists each in-flight item for multi-line reporters. Presentation is optional (`progress.itemNoun` / `progress.formatMessage` / `progress.detailLimit`); neither path creates another live reporter frame. |
| Result              | The default output is the typed child result. `mapResult` may transform it into a domain-specific parent-step output. A child result is usable only when its status is `"completed"`; best-effort child results must be handled through an explicit ordinary step that calls `run()` and inspects the structured result.                                                                                                                                                                                                                                                                                                 |
| Failure             | An unusable child result fails the opaque parent step. Its error names the child pipeline and the first failing child step and message, with `code: "TUBELESS_CHILD_FAILED"`, `phase: "execution"`, and `kind: "child"`; its JSON-safe cause chain retains the actionable child failure. When mapped children contain both cancellation and genuine failure, failure takes precedence; the aggregate is cancelled only when every unsuccessful child was cancelled.                                                                                                                                                      |
| Cancellation        | The child receives the exact parent `AbortSignal`. An already-aborted or later-aborted signal stops the child and transitions the parent step to `cancelled`.                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Dry run             | The child receives `dryRun: parentContext.dryRun` and applies its own per-step policy. Child steps with `dryRun: "skip"` are skipped; ordinary child steps run normally.                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Selective execution | Selecting or targeting the opaque parent step runs the child according to its mapped controls. Parent selection is never forwarded into the child's ID namespace.                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Checkpoints         | The adapter adds no checkpoint behavior. The child receives mapped options and the normal runtime context.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

## Guarantees

Call sites infer required and optional dependency inputs, parent domain
options, required child options, the default child result, and a transformed
`mapResult` output without explicit generic arguments. Missing required child
options fail at compile time.

The parent plan contains only the opaque stage. The child receives the
parent's working directory, logger, clock, sleep function, and abort signal.
Parent hooks see no raw child lifecycle events. The internal bridge converts
the child's canonical step statuses into monotonic progress on the opaque
parent step.

Parent dry-run precedence prevents a child side-effecting step from running.
An unusable child result fails one opaque parent step and names the child
pipeline, step, and error, including when `continueOnError` produced a
best-effort final value. Later cancellation interrupts in-flight child work.
An invalid child plan fails before the child starts.

`fromPipeline` identity (no `mapResult`) uses overloads so the parent-facing
output stays the child result.

## Out of scope

Policy skip plus `TOut | undefined` typing cover skip-without-run for opaque
`fromPipeline` steps. Runner substitution and any richer skipped-output shape
beyond policy skip are not supported.

Hierarchical or versioned external events, flattened or namespaced child
selection, and parallel DAG scheduling remain out of scope. Mapped children
provide bounded parallelism inside one opaque parent step; they do not make
the pipeline DAG executor parallel.
