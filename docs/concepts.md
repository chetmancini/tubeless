# Core concepts

## Definition model

A pipeline is an ordered declaration of typed steps plus a finalizer.
`definePipeline` immediately rejects invalid static graphs (duplicate/reserved
IDs, missing or contradictory dependencies, and cycles) and stores a compiled
graph. Planning applies option-dependent step selection against that compiled
graph and does not re-validate the definition.
Dependency arrays are snapshotted in that compiled storage; caller-owned step
objects are left unchanged.

Literal duplicate step IDs are also rejected by TypeScript at the
`definePipeline` call. Runtime definition validation remains the backstop for
widened arrays and dynamically assembled definitions.

Use one `createSteps<TOptions>()` factory per pipeline. A step object is both its
definition and its typed dependency token.

The ID is the stable machine identity used for dependencies, output keys,
selection, and tracing. An optional `name` overrides how reporters and printed
plans display the step without changing that identity.

## Dependency choices

| Field                | Supplies data | Blocks after failure | Typical use                         |
| -------------------- | ------------- | -------------------- | ----------------------------------- |
| `dependsOn`          | Required      | Yes                  | Transformation needs upstream value |
| `optionalDependsOn`  | When present  | No                   | Fallback or partial rerun           |
| `skipAfterFailureOf` | No            | Yes                  | Publish/write safety gate           |

Prefer required dependencies unless partial execution is an intentional part of
the workflow. A failure gate blocks after either `failed` or `cancelled`; both
mean the guarded prerequisite did not safely complete.

Shorter aliases such as `needs`, `uses`, and `gatedBy` were evaluated and not
adopted. `uses` does not communicate optionality, and aliases would leave two
vocabularies for the same graph. The explicit fields above remain canonical.

## Three kinds of non-execution

- **Structural skip:** a dependency, dry-run rule, filter, abort, or fail-fast
  decision prevents execution. Dependents that require the step do not run.
- **Policy skip:** a `step.skippable` predicate deliberately decides that work
  is unnecessary. It may publish a value and unlock dependents.
- **Failure:** the step ran and threw. Fail-fast stops new work by default;
  `continueOnError` lets independent work proceed.

`continueOnError` changes scheduling, not success: the structured run result
remains unsuccessful and `runOrThrow` still throws. Inspect `run()` when a
best-effort final value is useful despite recorded failures.

Any `step.skippable` step has output type `T | undefined`, even if current skip
paths publish a value. Dependents must handle the absence explicitly.

## Selection and finalization

Pipeline definitions declare supported downstream goals with step references:

```ts
definePipeline({
  id: "publish",
  steps: [build, validate, publish],
  targets: [publish],
  finalize: requireOutputs([publish], ({ publish }) => publish),
});
```

At call sites, `targets` accepts only those declared literal IDs. The planner
recursively selects each target's required inputs and failure gates, while
leaving optional-only inputs out. `pipeline.targetIds` and CLI `--target`
discovery expose the same declared set. Internal steps are not public goals;
`stepIds` remains an exact filter for partial reruns and other advanced
workflows and does not add prerequisites. Empty selections, unknown,
undeclared, or duplicate IDs, and a run that supplies both fields fail during
planning.

Every planned step includes `selectionReasons`, a stable discriminated union
that explains inclusion or omission without requiring callers to reconstruct
the graph. A target plan can report a direct `target`, a
`required-dependency`, a `failure-gate`, an excluded `optional-only` input, or
an `outside-target-closure` omission. Exact filters use `exact` and
`not-selected`; unfiltered plans use `all`.

```ts
const plan = pipeline.plan({ targets: ["publish"] });
const load = plan.steps.find((step) => step.id === "load");

// A shared prerequisite can explain every path that selected it.
load?.selectionReasons;
// [{ kind: "required-dependency", dependentId: "build", targetId: "publish" }]
```

`selected` remains the convenient boolean and `skipReason` describes execution
disposition such as `filtered`, `dry-run`, or `unmet-dependency`.

Render a plan at the presentation boundary instead of duplicating its selection
reason switch in each command or tool:

```ts
import { renderPipelinePlan } from "tubeless/render";

const plan = pipeline.plan({ targets: ["publish"] });
const terminalText = renderPipelinePlan(plan);
const machineJson = renderPipelinePlan(plan, { format: "json" });
```

Human output explains target and dependency provenance by default; pass
`{ explain: false }` for a compact disposition-only view. JSON output preserves
the original structured plan fields for machine consumers.

## Step statuses and structured errors

Steps have one canonical, enforced lifecycle:

```text
planned ──┬──> running ──┬──> complete
          │              ├──> skipped
          │              ├──> cancelled
          │              └──> failed
          ├──> skipped
          └──> cancelled
```

The runtime derives focused hooks from this state machine. Use
`onStepStart`, `onStepProgress`, `onStepComplete`, `onStepSkip`,
`onStepCancel`, or `onStepFail` for ordinary pipeline integration; each
callback receives metadata narrowed to that case. `onStepPlan` is available
for plan-aware tooling. `onStepStatus` is an additive catch-all for consumers
that need the complete discriminated lifecycle, such as renderers and event
stores. Registering it does not replace the focused callbacks.

A `running` status may be published repeatedly as progress changes. Every
selected step ends in exactly one terminal report; cancellation is distinct
from failure, including selected steps that were cancelled before they started.

```ts
const hooks: PipelineHooks = {
  onStepProgress({ progress, step }) {
    renderProgress(step.id, progress);
  },
  onStepSkip({ reason, step }) {
    explainSkip(step.id, reason);
  },
  onStepFail({ error, step }) {
    reportError(step.id, error);
  },
  onStepCancel({ error, step }) {
    reportCancellation(step.id, error);
  },
};
```

Every `PipelineError` has package-owned `code`, `phase`, and `kind` fields.
Branch on those fields rather than message text. `phase` locates the lifecycle
boundary (`definition`, `planning`, `execution`, or `finalization`); `kind`
distinguishes definition, selection, step, dependency, cancellation, child, and
finalization problems. If a thrown error supplied its own machine code, it is
retained separately as `sourceCode`. Native `Error.cause` chains are copied into
a bounded, cycle-safe `PipelineErrorCause` tree containing only message, name,
source code, and nested cause fields, so reports and trace events stay JSON-safe.

```ts
const result = await pipeline.run(options);
const first = result.errors[0];

if (first?.code === "TUBELESS_STEP_FAILED" && first.sourceCode === "ENOENT") {
  // A step failed because its underlying operation could not find a file.
}
```

`runOrThrow` raises `PipelineExecutionError` with the full structured result on
`result` and the original thrown value on native `cause`. Its default message
identifies the pipeline, phase, package code, step, and deepest normalized cause.
`PipelineDefinitionError` uses the same diagnostic summary for every rejected
definition issue. `renderPipelineError` from `tubeless/render` exposes that
same diagnostic formatting directly and can emit the structured error as JSON.

`PipelineStepReport` is the terminal-state union. Successful reports carry
timing, skipped reports carry `reason` plus optional `message` and
`dependencyId`, and failed/cancelled reports carry a structured `error`.
Hooks and tracing consume the same terminal objects rather than reconstructing
status from separate callbacks.

## Versioned run records

`run()` returns one versioned `PipelineRun<TResult>`. Every execution has a
`runId`, terminal `status`, start and finish timestamps, structured errors, and
one terminal report per planned step. Pass `context.runId` and
`context.parentRunId` when an external orchestrator owns correlation; otherwise
core generates an opaque run ID. The same IDs are available in step contexts
and optional trace exports.

An actual step execution receives one `attemptId`. It appears on the
`PipelineStepContext`, its terminal `PipelineStepReport`, and trace lifecycle
records. Executed reports also carry start and finish timestamps. Structural
skips and steps cancelled before starting have neither an attempt ID nor a start
timestamp because their handlers never ran. `context.reportAttempt()` describes
retry activity within that execution; it does not create another persisted
attempt model.

The terminal record deliberately does not copy log or progress streams. Use the
injected logger and hooks for live observation, or tracing when durable event
export is required. Errors and cancellation remain represented directly in the
run and terminal step reports. A failing `tracing.exporter` does not fail the
run: the executor warns once on the first export or flush error for that emitter
and drops later events. Nested child runs each construct their own emitter, so
`tracing.onExporterError` fires once per nested run rather than once for the
whole parent tree. The run currently has `version: 2`, also exported
as `RUN_MODEL_VERSION`; persist that field and branch on it before decoding a
stored run. Projected `StoredPipelineRun` snapshots stamp the same version.
Durations are derived by subtracting the relevant timestamps.

```ts
const result = await pipeline.run(options, undefined, {
  ...defaultPipelineContext(),
  runId: externalJobId,
});

result.runId;
result.status;
result.steps.find((step) => step.attemptId)?.attemptId;
result.finishedAtMs - result.startedAtMs;
```

### Local event store and studio

The local studio is a composition of existing boundaries, not part of pipeline
execution:

```text
pipeline definition → dependency-free executor → trace exporter
                                               ↘ append-only SQLite
                                                  ↘ local studio
                                                     ↘ injected command launcher
```

`openSqlitePipelineRunStore()` implements `PipelineTraceExporter` and appends
every lifecycle record to one versioned SQLite event table. Database triggers
reject updates and deletes. Current run state, history, step attempts, progress,
logs, errors, and observed definition graphs are projections of that immutable
stream; they are not competing executor models.

The SQLite adapter also exposes an explicit `clearHistory()` maintenance reset.
It deletes the complete event history and compacts the database while restoring
the append-only triggers in the same transaction; individual event updates and
deletes remain forbidden. The workbench injects this capability into its
loopback studio with a destructive confirmation and refuses to clear while it
knows a browser-launched run is still live. Persisted runs left active by an
interrupted process can still be cleared after confirmation. A directly embedded
studio stays history-immutable unless its caller explicitly injects the same
capability and may report its own known live writers through `isBusy()`.

Trace-enabled contexts route calls made through `context.log` into correlated
`pipeline.log` events while still forwarding them to the injected logger.
Definition metadata is attached to `step.planned` records, so the studio can
render observed graphs without importing application pipeline modules.
Opaque child steps include `nested_pipeline` on those records. Progress-bearing
`step.running` events carry the parent summary plus bounded `details` rows so
history can show the same per-item status as the live TTY. The
first planned step from a newer run replaces that pipeline ID's observed targets
and steps, so a changed definition does not retain older structure while a run
that fails validation before planning does not erase the last usable graph.

The main `tubeless` entrypoint never imports SQLite or the UI. The optional
`tubeless/run-store/sqlite` adapter selects the runtime-provided SQLite
implementation, and `tubeless/run-store/ui` is a separate HTTP projection.
It is read-only unless the caller injects a `PipelineRunStudioLauncher`.
Likewise, ordinary `tubeless run` remains unchanged; pass `--store` to record a run,
`--trace` for NDJSON, `tubeless history` to inspect the store, and `tubeless ui`
only when a browser view is useful.

Observed definitions are never treated as executable registrations: an event
stream does not contain a trusted module path or a command's domain contract.
`tubeless ui --command ./path/to/command.ts` explicitly loads only marked
`definePipelineCommand` exports and passes bounded structured form values
through their validation, option mapping, and execution path. No shell or argv
round trip is involved. Launch-enabled workbench servers are restricted to
loopback, while the UI HTTP module stays execution-agnostic through its injected
capability. Each command exposes an immutable, JSON-safe descriptor derived
from the same effective schema used by its parser, including built-in flags.
The studio uses that descriptor for checkboxes, numeric inputs, constrained
selects, paths, and repeatable values.
Planning is a separate read-only capability: **Preview plan** passes the current
dry-run and step/target values to the real pipeline planner and expands the
result beneath the launch form. Domain parameters remain visible for the
eventual run but are not interpreted by the planner, no run is recorded, and
previewing is optional. Opaque `fromPipeline` and `forEachPipeline` steps carry
`nestedPipeline` metadata so the preview can distinguish ordinary work from a
single child pipeline or runtime fan-out without flattening child selection.

Studio snapshots page through the store once and then fetch only events after
the last observed sequence. Those pages go through `createPipelineRunProjector`
from `tubeless/run-store`; a refresh with no newer ids returns the cached
snapshot instead of re-folding history. Store-local event ids are monotonic and
may start at `0`. Duplicate or out-of-order ids are ignored. Use
`projectPipelineRunStore` when the caller already holds a complete event list
and does not need incremental refresh. History therefore continues past an
adapter's per-query safety cap without reloading the entire database on every
refresh.

For a reusable catalog, `definePipelineStudio` declares versioned command-module
references in one dependency-free manifest. Run `tubeless ui ./tubeless.studio.ts` to
load it. Module paths and the optional execution `cwd` resolve from the manifest
instead of the caller's shell directory; duplicate or malformed declarations
fail before the server listens. Presentation-name overrides never change run or
pipeline identity.

Cancellation is classified from an actual abort error or propagated child
cancellation, not merely from the signal's current state. An unrelated failure
that races with `abort()` remains a step or finalization failure.

Finalizer inputs remain partial because dry-run policy, exact filtering, and
best-effort execution can omit outputs. Wrap a normal finalizer with
`requireOutputs([stepA, stepB], callback)` to declare which output slots make a
valid result. The callback receives those values as required properties, and
the run fails finalization with the missing step IDs if any slot is absent. A
successfully published `undefined` still counts as an output; structural
absence is determined by whether the slot was published.

When a pipeline uses `requireOutputs`, every declared target is checked during
definition construction. Its required-input and failure-gate closure must
contain all required finalizer steps, so an advertised target cannot complete
its work and then fail only because it intentionally omitted the pipeline's
result. Plain finalizers remain appropriate when selected goals intentionally
produce a partial domain result.

### Why targets are declared

Three contracts were evaluated after dependency-aware selection shipped:

- expose every step as a target and keep the global finalizer;
- add a separate selected-execution runner returning raw output slots; or
- declare the pipeline's meaningful public goals and retain one finalized
  domain result.

Declared targets were selected because they preserve the existing
`run`/`runOrThrow` result contract, add only one short definition field, keep
steps as implementation details, and let definition validation prove
`requireOutputs` compatibility. A second runner would create competing
execution/result semantics, while goal-specific finalizers add ceremony that
current production pipelines do not need. Exact `stepIds` remains the explicit
escape hatch for low-level partial work.

## Dry runs

Every step has one normal `run` handler and an optional dry-run policy:

- Omit `dryRun` when the normal handler is safe and useful during a dry run.
- Set `dryRun: "skip"` for filesystem writes, database mutation, publication,
  email, and other external side effects. The step is reported as structurally
  skipped and its required dependents do not run.
- Provide a `dryRun(inputs, context)` handler to substitute a side-effect-free
  preview. It must return the same output type as `run`, so dependents can use
  the preview normally.

```ts
const publish = step("publish", {
  dependsOn: [build],
  dryRun: ({ build }) => ({ id: `preview:${build.id}` }),
  run: ({ build }) => publishArtifact(build),
});
```

Dry run is not a rollback mechanism. Read-only validation and resolution steps
may run normally so the preview remains useful.

## Validated boundaries

`tubeless` implements the small Standard Schema V1 structural contract and
does not import a validation library. Pass a domain-options schema to
`createSteps(schema)`, an `outputSchema` to an ordinary step, or a
`resultSchema` to `definePipeline`:

```ts
const step = createSteps(optionsSchema);

const parse = step("parse", {
  outputSchema: parsedRowsSchema,
  run: (_inputs, context) => readRows(context.options.source),
});

const pipeline = definePipeline({
  id: "validated-import",
  steps: [parse],
  resultSchema,
  finalize: requireOutputs([parse], ({ parse }) => summarize(parse)),
});
```

Schema input and output types are inferred independently. Callers pass the
options schema's input type, steps read its validated output type, a step's
`run` and dry-run handler return its schema input type, dependents receive its
schema output type, and `runOrThrow` returns the result schema's output type.
Built-in run controls are separate from domain-options validation, so strict
object schemas do not need to know about `dryRun`, `targets`, or other executor
policy. Callers pass those controls alongside domain fields; the executor removes
the reserved control keys before validation while preserving class methods,
getters, inherited and non-enumerable properties, and symbol keys. Steps receive
the validated output object directly; the executor neither flattens it nor
overlays control fields onto it.

Options are validated once after structural planning and before any step
starts. Step values are validated before publication, including values from a
custom dry-run handler or policy skip. Finalized values are validated before a
run is marked successful. Sync and async Standard Schema validators are both
supported during `run`; `plan()` stays synchronous and does not invoke schemas.

Failures retain normalized issue messages and paths on `PipelineError.issues`.
Use the stable codes `TUBELESS_OPTIONS_VALIDATION_FAILED`,
`TUBELESS_STEP_OUTPUT_VALIDATION_FAILED`, and
`TUBELESS_FINAL_RESULT_VALIDATION_FAILED` to distinguish boundaries. A step-output
failure is reported on that step; final-result failure uses
`__finalize__`. Pipeline definitions cannot mix steps from different
options-schema factory scopes.

## Child pipelines

Use `step.fromPipeline` for one child run and `step.forEachPipeline` when runtime
items each need the same child. Children are opaque to the parent's plan and
hooks; their activity is summarized as progress on the parent step. See
[child-pipeline composition](./child-pipeline-composition.md) for propagation and
selection boundaries.

## Remote steps

Use `step.fromRemote` when one parent step's work lives on another engine.
The parent plan stays local and opaque; `remote.engine` and optional
`remote.target` are presentation only. Dry-run remains a side-effect gate:
omitting `dryRun` still calls the adapter. See
[remote-step composition](./remote-step-composition.md).

## Mermaid diagrams

Call `pipeline.toMermaid()` to generate a static flowchart without run options
or execution. Nodes use `name ?? id`; generated internal node identifiers keep
arbitrary user-facing text out of Mermaid syntax. Required dependencies render
as solid arrows, while optional inputs and failure gates render as labeled
dotted arrows. Use `direction` to change layout and `includeDescriptions` to add
operational descriptions to node labels.

## Module workbench

Command-by-command usage lives in [the CLI](./cli.md). The optional local UI is
documented in [the studio](./studio.md).

`tubeless inspect`, `tubeless plan`, and `tubeless graph` load a pipeline or a
marked `definePipelineCommand` without executing steps or requiring domain
options, and prefer the command when both are exported. `tubeless run`
deliberately accepts only a command created by `definePipelineCommand`, because
that export carries the application-owned parser, validation, option mapping,
reporter, and result summary needed for safe execution. A raw pipeline is not
executable through the workbench. `tubeless history` reads the optional local
SQLite store; `tubeless run --trace` writes NDJSON without requiring a store.

`definePipelineCommand` defaults to a same-name mapping when its validated flag
values structurally satisfy the pipeline's domain options. Command-only values
such as `resume`, `stepIds`, and `targets` are removed before execution;
bridge-owned selection and failure controls are applied separately. The argv
flags stay `--resume`, `--step`, and `--target`. If flags do not satisfy
required domain options, `mapOptions` remains required at compile time. Keep
explicit mapping for renamed fields, file loading, adaptive defaults, prompts,
or other derived values.

The returned command's `descriptor` is the non-terminal view of that contract:
name, description, and immutable parameter metadata for flags, types, defaults,
choices, numeric constraints, repeatability, paths, and positional support. It
is presentation-neutral; consumers still submit argv through `parse` or `run`
so one validation and execution path remains authoritative.
`command.plan()` always exposes structural planning from `PipelineRunControls`
(`dryRun`, `stepIds`, and `targets`) only. It deliberately skips domain parsing, option mapping,
execution, and persistence. Use `command.plan()` or `tubeless plan`; do not
simulate planning with `--plan`.

Keep the workbench's module-selection arguments before the `--` boundary and
the command's application arguments after it:

```sh
tubeless run --export PublishCommand ./scripts/publish.ts -- --source input.json --target publish
```

The workbench forwards SIGINT through the command context and classifies exits
as validation, planning, execution, or cancellation without parsing diagnostic
messages.

## Runtime context

Use the step context instead of global facilities:

- `context.options` for validated domain options and `context.dryRun` for the active mode.
- `context.log` so interactive reporters can preserve output.
- `context.signal` for cooperative cancellation.
- `context.sleep` for cancellation-aware, testable delays.
- `context.reportProgress` and `context.reportAttempt` for observability.
- `context.cwd` for caller-controlled path resolution.

Callers may inject the logger, clock, sleep function, signal, hooks, and tracing.
This makes a pipeline embeddable and deterministic under test.

## Deterministic testing

`createPipelineTestRuntime` from `tubeless/testing` packages the ordinary
runtime injection points into a framework-neutral harness. Its default sleep
advances a monotonic clock immediately, its logger stays silent while capturing
calls, and its canonical status hook records lifecycle events and latest
progress. The harness owns an `AbortController` and delegates `run`,
`runOrThrow`, and `plan` to the real pipeline, preserving option and result
inference without implementing alternate execution semantics.

Create one runtime per test. Customize `sleep` when a test needs to pause,
interleave, or advance time differently; call `test.abort()` to exercise the
normal cancellation path. Assertions remain application- or framework-owned.

## Stable boundaries

- Keep step IDs stable, use `name` only for a friendlier display label, and keep
  descriptions operationally useful.
- Generate documentation from `pipeline.toMermaid()` instead of hand-maintaining
  a second copy of the graph.
- Return small domain results; inspect `run()` reports for execution metadata.
- Put remote API mechanics in retry/rate-limit helpers, not in the executor.
- Put CLI parsing at the script edge with `definePipelineCommand`.
- Keep application-owned telemetry SDKs outside the dependency-free core.
