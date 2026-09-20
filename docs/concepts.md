# Core concepts

## Steps, dependencies, and results

A pipeline describes a series of steps and the values passed between them.
Each step has an ID, a function to run, and any dependencies. A finalizer
combines step outputs into the value returned to the caller.

Create steps with one `createSteps<TOptions>()` factory per pipeline. Take its
`step` constructor, then pass a step object to another step's
`dependsOn` array to require its output;
TypeScript then infers that input's type.

`definePipeline` checks the graph immediately. Duplicate or reserved IDs,
missing dependencies, contradictory dependencies, and cycles cause a
`PipelineDefinitionError`. TypeScript also catches duplicate literal step IDs.
The definition stores a copy of the dependency arrays, so later changes to
those arrays do not alter the graph.

Keep IDs stable: dependencies, output keys, selection, and traces use them.
Set `name` when a step needs a different label in plans and progress reports.
Changing the label does not change the ID.

## Dependency choices

| Field                | Supplies data | Blocks after failure | Typical use                         |
| -------------------- | ------------- | -------------------- | ----------------------------------- |
| `dependsOn`          | Required      | Yes                  | Transformation needs upstream value |
| `optionalDependsOn`  | When present  | No                   | Fallback or partial rerun           |
| `skipAfterFailureOf` | No            | Yes                  | Publish/write safety gate           |

Prefer required dependencies unless partial execution is an intentional part of
the workflow. A failure gate blocks after either `failed` or `cancelled`; both
mean the guarded prerequisite did not safely complete.

For example, a publish step that needs a validated artifact should require the
validation step with `dependsOn`. If it needs only the build output but must
stop when validation fails, use `skipAfterFailureOf` for validation. An
`optionalDependsOn` entry alone does not block publication after a failure.

## Skips and failures

A step can be omitted before its handler starts, intentionally skip its work,
or fail while running. These cases have different effects on dependent steps.

| Outcome         | What happened                                                                             | What dependents receive                              |
| --------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Structural skip | A filter, dry-run rule, missing dependency, abort, or earlier failure prevented execution | No output; required dependents cannot run            |
| Policy skip     | A step's `skip` predicate decided that work was unnecessary                               | The supplied skip value, or `undefined`              |
| Failure         | The step's work failed                                                                    | No successful output; required dependents cannot run |

Fail-fast is the default: a failure stops new work. Set `continueOnError` to
allow independent steps to proceed. The run still reports failure, and
`runOrThrow` still throws. Use `run` to inspect any partial result.

Adding `skip` to a step definition makes it skippable. Its output is always
typed as `T | undefined`, even if all current skip paths return a value.
Dependent steps must handle that possible absence.

## Execution controls

Pass business inputs as the first argument and execution controls as the second:

```ts
await pipeline.run(options, { dryRun: true });
await pipeline.run(options, { maxConcurrency: 4 });
await pipeline.runOrThrow(options, { targets: ["publish"] });
```

| Control           | Default   | Effect                                                                     |
| ----------------- | --------- | -------------------------------------------------------------------------- |
| `dryRun`          | `false`   | Applies each step's dry-run policy; unmarked steps still run               |
| `maxConcurrency`  | `1`       | Limits simultaneous steps, including skip predicates and output validation |
| `continueOnError` | `false`   | Lets independent work continue after a failure                             |
| `targets`         | All steps | Selects declared goals and their required dependencies and failure gates   |
| `stepIds`         | All steps | Selects exactly the listed steps, without adding dependencies              |

`targets` and `stepIds` cannot be combined. Use `pipeline.plan(controls)` to
check selection before running. Planning requires no business inputs and does
not call step handlers or schema validators.

`maxConcurrency` must be a positive finite integer. Invalid values fail the run
with `TUBELESS_RUN_CONCURRENCY_INVALID` before options validation or step execution.
The default of `1` preserves existing serial execution, including the ordering
of independent side effects. Opt in only when independent steps can safely overlap.
Declare ordering constraints as graph edges when side effects must run in sequence.

All three edge types are scheduling prerequisites: a step waits until each required
input, optional input, and failure gate is terminal (completed, failed, skipped, or
cancelled). Their existing output and failure policies then determine whether it
runs. Ready steps dispatch in the compiled topological order, with declaration
order breaking graph ties. A freed slot can start a dependent immediately, without
waiting for unrelated steps. Skip predicates and output schemas, including schemas
for policy-skip values, occupy the same slot as the step handler.

Failure and cancellation have separate dispatch policies:

| Condition                          | New work                              | In-flight work                                             | Unstarted steps                                                                                                                        |
| ---------------------------------- | ------------------------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `continueOnError: false` (default) | Stop after the first observed failure | Let every active step settle; do not abort it              | Report `fail-fast`, retaining already planned structural skip reasons                                                                  |
| `continueOnError: true`            | Continue eligible branches            | Let every active step settle                               | Required descendants skip for unmet dependencies; failure gates skip after an unsuccessful prerequisite; optional inputs may be absent |
| External `context.signal` abort    | Stop regardless of `continueOnError`  | Forward the same signal and wait for active work to settle | Cancel unstarted selected steps; filtered steps remain skipped                                                                         |

Fail-fast does not create an abort signal or cancel active work. Cancellation is
cooperative: a handler that ignores the signal must still settle before the run
returns, and its actual outcome is retained. An external abort while draining after
a failure takes precedence for unstarted selected steps, including those with a
planned dry-run or unmet-dependency skip. Already-terminal steps keep their outcomes.

Every concurrent failure is recorded. Any non-cancellation error makes the run
`failed`, even when other steps are cancelled. A run containing only cancellation
errors is `cancelled`. With `continueOnError`, the finalizer receives all available
outputs once active work has settled; an aborted signal prevents the finalizer's
handler from running. Without `continueOnError`, any step error prevents finalization.

Live hooks and trace events retain actual event order. Final `result.steps` is in
stable plan order. Final `result.errors` places run-level errors first, then step
errors in plan order, then finalization errors; errors with the same position retain
their observation order. `runOrThrow` retains every error in its result and selects
its message and original cause from that ordered list. The first reported step error
therefore need not be the failure that triggered fail-fast; skipped steps retain
that triggering step's ID in `dependencyId`.

The default result still comes from the last step in the graph's stable topological
order, regardless of which step finishes last.

The limit applies to one pipeline run. A child wrapper occupies one parent slot;
child runs retain their own limit, defaulting to `1`. Set `maxConcurrency` in child
`mapOptions` to opt them in separately. Fan-out `concurrency` independently limits
simultaneous child runs. See the [parallel DAG recipe](../examples/parallel-dag.ts).

## Selection and finalization

A pipeline with a single goal can be `definePipeline({ id, steps })`. Omitted
`targets` exposes the last step in execution order; omitted `finalize` emits that step's
output, or `undefined` when the run did not publish it. These defaults use the complete graph's
**topological execution order**, so a downstream step remains the goal even if
listed before its prerequisites. Required dependencies, optional inputs, and
failure gates all affect that order. When several steps are ready, the scheduler
uses declaration order to break ties. An empty pipeline has no targets and its
default result is `undefined`.

Step types do not retain their dependency graph. Implicit target types therefore
include all declared step IDs, and the default result type includes all step
output types plus `undefined`. Runtime exposes only the final execution-order
target and rejects other IDs. Use explicit `targets` or `finalize` when you need
narrower types.

Neither default limits an unfiltered run: it still selects all declared steps.
Set `targets: []` to expose no public goals.
An explicit finalizer retains its own result and can use `requireOutputs`.

Pipeline definitions can declare different downstream goals with step references:

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

Each planned step includes `selectionReasons`, which explains why it was
selected or omitted. A target plan can report a direct `target`, a
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

`selected` tells you whether selection includes the step. `skipReason` explains
why it will not run, such as `filtered`, `dry-run`, or `unmet-dependency`.

Use the structured plan directly in applications. For terminal or JSON output,
the workbench already renders the same data through `tubeless plan`.

### Required final outputs

A finalizer may receive only some step outputs: dry runs, exact step filters,
and failures can leave others missing. Use
`requireOutputs([stepA, stepB], callback)` when a valid result needs those
outputs. It checks their presence and makes them required properties in the
callback. If an output is missing, finalization fails and reports its step ID.
A step that successfully returns `undefined` still produced an output; that
is different from a step that never supplied one.

Tubeless also checks declared targets, including the implicit last-step target,
against these requirements. Each target
must include all steps needed by `requireOutputs`, either directly or through
its dependencies and failure gates. Use a plain finalizer when different
selected goals are allowed to return partial results. The default finalizer
reads only the last step in execution order; it never falls back to an earlier output.
If independent finalizer inputs are outside the implicit target closure, declare
a target that includes them or opt out of public targets with `targets: []`.

## Step statuses and structured errors

A step moves through these states:

```text
planned ──┬──> running ──┬──> complete
          │              ├──> skipped
          │              ├──> cancelled
          │              └──> failed
          ├──> skipped
          └──> cancelled
```

Hooks let your application respond to these changes. Use `onStepStart`,
`onStepProgress`, `onStepComplete`, `onStepSkip`, `onStepCancel`, or `onStepFail`
for a specific event; TypeScript narrows the callback data to that event.
Use `onStepPlan` to observe planning. Use `onStepStatus` when one listener
needs every status, for example to update a progress display. It runs in
addition to any specific hooks you register.

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

Every `PipelineError` has `code`, `phase`, and `kind` fields defined by
Tubeless. Branch on those fields rather than message text. `phase` identifies
where the error occurred (`definition`, `planning`, `execution`, or `finalization`); `kind`
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
definition issue. Applications should branch on the structured fields and own
any domain-specific presentation.

`PipelineStepReport` describes a step's final status. Successful reports carry
timing, skipped reports carry `reason` plus optional `message` and
`dependencyId`, and failed/cancelled reports carry a structured `error`.
Hooks and trace events use these same reports.

## Versioned run records

`run()` returns one versioned `PipelineRun<TResult>`. Every execution has a
package-generated `runId`, terminal `status`, start and finish timestamps,
structured errors, and one terminal report per planned step. Pass
`context.correlationId` when an external orchestrator owns a reusable job or
workflow identifier. Pass `context.parentRunId` only when linking to another
Tubeless execution ID. The same identities are available in step contexts and
optional trace exports.

An actual step execution receives one `attemptId`. It appears on the
`PipelineStepContext`, its terminal `PipelineStepReport`, and trace lifecycle
records. Executed reports also carry start and finish timestamps. Structural
skips and steps cancelled before starting have neither an attempt ID nor a start
timestamp because their handlers never ran. `context.reportAttempt()` records retry progress inside that step execution;
it does not create a new `attemptId`.

The run report includes errors and cancellation details, but not a stream of
logs or progress updates. Use a logger and hooks for live updates, or a trace
exporter to record events for later inspection. A failing `tracing.exporter` does not fail the
run: the executor warns once on the first export or flush error for that emitter.
If a single exporter fails, later events are dropped. `composeTraceExporters` instead retires
a failed destination after reporting the first partial drop and keeps sending to
healthy destinations. Nested child runs each construct their own emitter, so
`tracing.onExporterError` fires once per nested run rather than once for the
whole parent tree. The run currently has `version: 2`, also exported
as `RUN_MODEL_VERSION`; persist that field and branch on it before decoding a
stored run. Projected `StoredPipelineRun` snapshots stamp the same version.
Durations are derived by subtracting the relevant timestamps.

```ts
const result = await pipeline.run(options, undefined, {
  correlationId: externalJobId,
});

result.runId;
result.correlationId;
result.status;
result.steps.find((step) => step.attemptId)?.attemptId;
result.finishedAtMs - result.startedAtMs;
```

Trace events use the version 2 discriminated payload model. Every event carries
a unique execution `runId` and keeps reusable external correlation separate.
`tubeless/tracing` intentionally exposes only that typed event union, the exporter
interface, and exporter composition. Concrete JSON and telemetry SDK adapters
belong in the workbench or application integration; see the
[tracing recipe](../examples/tracing.ts). This narrow API does not weaken the
recording contract: existing version 2 NDJSON traces remain readable by
`tubeless history` and `tubeless ui`.

### Local event store and studio

Record events when you need to inspect runs after the process exits. The CLI
can write a SQLite database with `--store`, an NDJSON trace with `--trace`, or
both. NDJSON stores one JSON event per line. Use `tubeless history` to inspect
recordings in the terminal or `tubeless ui` to open them in a browser.

Recording is optional. Importing `tubeless` does not load SQLite or the UI.
Storage readers and projections belong to the workbench rather than the runtime
API. See [the studio guide](./studio.md) for recording, storage limits, and
browser controls.

Cancellation is determined from an abort error or a cancelled child run. If an
unrelated error occurs at the same time as an abort, it remains a failure.

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

TypeScript checks types at build time. To check values from files, requests, or
other external sources at runtime, use a validator that supports Standard
Schema V1. Tubeless accepts these schemas without importing a validation library. Pass a domain-options schema to
`createSteps(schema)`, an `outputSchema` to an ordinary step, or a
`resultSchema` to `definePipeline`:

```ts
const { step } = createSteps(optionsSchema);

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

Schemas can validate and transform values. TypeScript infers the types on both
sides of each validation step:

| Schema         | Value it receives                                                        | Value available after validation |
| -------------- | ------------------------------------------------------------------------ | -------------------------------- |
| Options schema | The caller's domain options                                              | `context.options` in each step   |
| `outputSchema` | The step's return value, including custom dry-run and policy-skip values | Input to dependent steps         |
| `resultSchema` | The finalizer's return value                                             | The final pipeline result        |

Built-in run controls are passed separately from domain options, so strict
object schemas do not need fields for `dryRun` or `targets`. For child
`mapOptions`, which combines options and controls in one object, Tubeless
separates the controls before validation. The options object retains its
methods, getters, inherited properties, non-enumerable properties, and symbols.
Steps receive the validated object without added control fields.

With no `finalize`, `resultSchema` validates the output of the last step in
execution order, including `undefined` when that output is absent. A schema may
therefore reject a dry run or filtered run. When the inferred union of possible
outputs cannot satisfy the schema input, supply a compatible finalizer. The successful result type remains the
schema's output type.

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

Use `fromPipeline` to run one reusable child pipeline. Use `forEachPipeline` to
run that child for each item in a list. The parent
plan contains one wrapper step; child activity appears as progress beneath it.
Read [child-pipeline composition](./child-pipeline-composition.md) for option
mapping, selection, failures, and progress controls.

Add `skip` to either child-step definition when the entire child step may be
intentionally omitted. Its output can be `undefined`, which dependent code must handle.

## Remote steps

Use `fromRemote` to call a service or execution engine from one step.
The parent pipeline still runs locally. The step's `remote.engine` and optional
`remote.target` describe the destination for display and inspection.

Omitting a dry-run policy still contacts the service during a dry run. Mark
unsafe calls with `dryRun: "skip"`, provide a local preview, or ensure the
remote service honors the dry-run flag. See
[remote-step composition](./remote-step-composition.md).

## Mermaid diagrams

Call `pipeline.toMermaid()` to generate a static flowchart without run options
or execution. Nodes use `name ?? id`; generated internal node identifiers keep
arbitrary user-facing text out of Mermaid syntax. Required dependencies render
as solid arrows, while optional inputs and failure gates render as labeled
dotted arrows. Use `direction` to change layout and `includeDescriptions` to add
operational descriptions to node labels.

## CLI commands

Wrap a pipeline with `definePipelineCommand` to give it command-line arguments,
validation, help, progress reporting, and a result summary. See
[`cli-job.ts`](../examples/cli-job.ts) for a complete example and
[the CLI guide](./cli.md) for all commands and flags.

`tubeless inspect`, `plan`, and `graph` accept a pipeline or command export.
They load the module without executing step handlers or requiring business
inputs. If a module exports both a pipeline and a command, they prefer the
command. Keep module imports free of side effects.

`tubeless run` requires a `definePipelineCommand` export. A raw pipeline can
instead be invoked from application code through `run` or `runOrThrow`.
Register commands in `tubeless.project.ts` to address them by stable project ID.
The [project manifest example](../examples/catalog/tubeless.project.ts) shows
file layout and registrations; the [Studio guide](./studio.md) shows how to
use the same catalog in the browser.

### Map command arguments to pipeline inputs

Omit `mapOptions` when validated flags already have the same names and types
as the pipeline's domain options. Supply it when inputs need to be renamed,
loaded from files, calculated, or prompted for. TypeScript requires the mapper
when the flag values alone cannot satisfy the pipeline's required options.

Command-only values such as `resume`, `stepIds`, and `targets` are removed from
domain options before execution. Selection and failure controls are applied
separately. The command-line flags are `--resume`, `--step`, and `--target`;
option mappers and hooks use the parsed property names.

A command's `descriptor` lists parameter names, descriptions, types, defaults,
choices, numeric constraints, repeatability, paths, and positional support.
Use it to build forms or other tools. Submit arguments through `parse` or `run`
to validate them; the descriptor only describes the parameters.

`command.plan()` accepts selection and dry-run controls without parsing domain
arguments, mapping options, executing steps, or recording a run. Use
`command.plan()` or `tubeless plan`; there is no command `--plan` flag.

Place CLI file-selection flags before `--` and pipeline-command arguments after
it:

```sh
tubeless run --export PublishCommand ./scripts/publish.ts -- --source input.json --target publish
```

The CLI forwards SIGINT to the run's abort signal and uses distinct exit codes
for validation, planning, execution, and cancellation errors. Pass `--store`
to record SQLite history or `--trace` to write an NDJSON file.

## Runtime context

The step context supplies inputs and services controlled by the caller:

- `context.options` for validated domain options and `context.dryRun` for the active mode.
- `context.log` to write messages through the active logger or reporter.
- `context.signal` to pass cancellation to I/O and other asynchronous work.
- `context.sleep` for cancellation-aware, testable delays.
- `context.reportProgress` to update progress and `context.reportAttempt` to report retries.
- `context.cwd` as the base directory for relative paths.

Callers may inject the logger, clock, sleep function, signal, hooks, and tracing.
This makes a pipeline embeddable and deterministic under test.

## Deterministic testing

`createPipelineTestRuntime` from `tubeless/testing` supplies a test clock, a
logger that captures messages, and hooks that record status changes and
progress. Its default sleep advances the clock immediately. Its `run`,
`runOrThrow`, and `plan` methods call the real pipeline with this context,
so tests exercise the same execution logic as normal runs.

Create one runtime per test. Customize `sleep` when a test needs to pause,
interleave, or advance time differently; call `test.abort()` to exercise the
normal cancellation path. Use your test framework to assert on the results. Replace external I/O yourself;
the test runtime does not mock network or filesystem operations.

## Implementation guidelines

- Keep step IDs stable, use `name` only for a friendlier display label, and keep
  descriptions operationally useful.
- Generate documentation from `pipeline.toMermaid()` instead of hand-maintaining
  a second copy of the graph.
- Return small domain results; inspect `run()` reports for execution metadata.
- Put remote API mechanics in retry/rate-limit helpers, not in the executor.
- Put CLI parsing at the script edge with `definePipelineCommand`.
- Keep application-owned telemetry SDKs outside the dependency-free core.
