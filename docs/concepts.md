# Core concepts

## Steps, dependencies, and results

A pipeline is a set of steps and the values passed between them. Each step has an
ID, a function, and dependencies. A finalizer combines step outputs into the
value returned to the caller.

Create steps with one `createSteps<TOptions>()` factory per pipeline. Pass a step
object to another step's `dependsOn` array to require its output; TypeScript
infers that input's type.

`definePipeline` checks the graph immediately. Duplicate or reserved IDs, missing
or contradictory dependencies, and cycles throw `PipelineDefinitionError`.

Keep IDs stable: dependencies, output keys, selection, traces, and CLI flags use
them. Set `name` for a friendlier label in plans and progress; it never changes
the ID.

## Wait for user or application input

`waitForInput` from the same `createSteps` factory pauses one branch until an
application-owned adapter replies:

```ts
const { step, waitForInput } = createSteps<{ draft: string }>();
const draft = step("draft", { run: (_inputs, context) => context.options.draft });
const feedback = waitForInput("feedback", {
  dependsOn: [draft],
  read: ({ draft }, context) => readFromYourUI(draft, context.signal),
});
```

The typed result feeds dependents like any step output. Add `outputSchema` to
validate untrusted input.

- Input steps skip dry runs by default; a `dryRun` callback can supply preview
  input. They cannot be cached or use `skip` predicates; gate dependent work with
  an ordinary step instead.
- Forward `context.signal` to the adapter. Cancellation stops waiting and ignores
  a late reply.
- The application owns persistence across process restarts.

See the [review pipeline recipe](../examples/user-input.ts). YAML and JSON
pipelines use registered handlers instead; see
[decisions, confirmations, and text](./declarative-pipelines.md#user-decisions-confirmations-and-text).

## Dependency choices

| Field                | Supplies data | Blocks after failure | Typical use                         |
| -------------------- | ------------- | -------------------- | ----------------------------------- |
| `dependsOn`          | Required      | Yes                  | Transformation needs upstream value |
| `optionalDependsOn`  | When present  | No                   | Fallback or partial rerun           |
| `skipAfterFailureOf` | No            | Yes                  | Publish/write safety gate           |

Prefer required dependencies unless partial execution is intentional. A failure
gate blocks after `failed` or `cancelled`. A publish step that needs a validated
artifact should use `dependsOn` on validation; if it needs only the build output
but must stop when validation fails, use `skipAfterFailureOf`. An
`optionalDependsOn` alone never blocks publication.

## Skips and failures

| Outcome         | What happened                                                                             | What dependents receive                              |
| --------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Structural skip | A filter, dry-run rule, missing dependency, abort, or earlier failure prevented execution | No output; required dependents cannot run            |
| Policy skip     | A step's `skip` predicate decided that work was unnecessary                               | The supplied skip value, or `undefined`              |
| Failure         | The step's work failed                                                                    | No successful output; required dependents cannot run |

Fail-fast is the default: a failure stops new work. Set `continueOnError` to let
independent steps proceed; the run still fails and `runOrThrow` still throws. Use
`run` to inspect a partial result.

A `skip` string or `{ reason }` publishes no value, so the output is typed
`T | undefined`. When every skip branch returns `{ reason, value }`, the output
stays `T`. For a schema-backed step, the fallback must satisfy the schema input
type. See [`conditional-step.ts`](../examples/conditional-step.ts).

## Execution controls

Pass business inputs first and execution controls second:

```ts
await pipeline.run(options, { dryRun: true });
await pipeline.run(options, { maxConcurrency: 4 });
await pipeline.runOrThrow(options, { targets: ["publish"] });
```

When no input field is required, call `pipeline.run()`. To pass controls without
input, use `run(undefined, controls, context)`. See the
[inherited inputs recipe](../examples/inherited-inputs.ts).

| Control           | Default   | Effect                                                                     |
| ----------------- | --------- | -------------------------------------------------------------------------- |
| `dryRun`          | `false`   | Applies each step's dry-run policy; unmarked steps still run               |
| `maxConcurrency`  | `1`       | Limits simultaneous steps, including skip predicates and output validation |
| `continueOnError` | `false`   | Lets independent work continue after a failure                             |
| `targets`         | All steps | Selects declared goals and their required dependencies and failure gates   |
| `stepIds`         | All steps | Selects exactly the listed steps, without adding dependencies              |

`targets` and `stepIds` cannot be combined. `pipeline.plan(controls)` validates
selection without business inputs and without calling handlers or schemas.

**Concurrency.** It overlaps asynchronous work; CPU-heavy synchronous handlers
still block the event loop (use a
[worker-thread adapter](./remote-step-composition.md#cpu-work-in-node-worker-threads)).
The default `1` preserves serial ordering of side effects. Raise it only when
independent steps can safely overlap, and declare ordering as graph edges. Ready
steps dispatch in topological order, declaration order breaking ties. See the
[parallel DAG recipe](../examples/parallel-dag.ts).

A child run keeps its own limit (default `1`; set it in child `controls`).
Fan-out `concurrency` limits child runs separately, and these limits multiply.
There is no shared semaphore, so parents holding slots while awaiting children
that need those slots can deadlock.

**Failure and cancellation.**

- Without `continueOnError`, the first failure stops new work. Active steps are
  not aborted; they settle first, and unstarted steps report `fail-fast`.
- With `continueOnError`, eligible branches continue. Required descendants skip,
  failure gates skip after an unsuccessful prerequisite, and the finalizer
  receives whatever outputs exist.
- An external `context.signal` abort stops new work regardless of
  `continueOnError`, cancels unstarted selected steps, and is forwarded to active
  ones. Cancellation is cooperative: a handler that ignores the signal still
  settles before the run returns, and its actual outcome is kept.
- Any non-cancellation error makes the run `failed`; only cancellation errors
  make it `cancelled`. Without `continueOnError`, any step error prevents
  finalization.

Live hooks see events in real order; `result.steps` is in stable plan order and
`result.errors` lists run-level, then step, then finalization errors. The first
listed step error need not be the one that triggered fail-fast; skipped steps
carry that step's ID in `dependencyId`.

## Reusing deterministic step outputs

A step opts into caching with `cache: { version: "v1" }`, or `cache: true` to
inherit the pipeline implementation version. Only the handler's raw result is
reused; selection, dependencies, skips, and output validation still apply. Hits
report `outputSource: "cache"`. See [step output caching](./step-output-cache.md).

## Selection and finalization

Without selection controls, the whole pipeline runs.

| Run controls               | Selected work                                                    |
| -------------------------- | ---------------------------------------------------------------- |
| Omitted                    | All declared steps                                               |
| `{ targets: ["publish"] }` | `publish` and its required inputs and failure gates, recursively |
| `{ stepIds: ["build"] }`   | Exactly `build`, without adding prerequisites                    |

Selection decides eligibility; dry-run policy, skips, failures, and cancellation
still govern whether a selected step executes.

The `targets` field on `definePipeline` declares which goals callers may select;
it does not select work. Omitted, the last step in execution order is the one
public goal; `targets: []` exposes none. Neither restricts an unfiltered run.
`pipeline.targetIds` and CLI `--target` expose the declared set.

```ts
definePipeline({
  id: "publish",
  steps: [build, validate, publish],
  targets: [publish],
  finalize: publish,
});
```

Required inputs and failure gates of a target are selected; optional-only inputs
are not. Empty, unknown, undeclared, or duplicate IDs, and supplying both
`targets` and `stepIds`, fail during planning.

Omitted `finalize` returns the last step's output in topological execution order
(declaration order breaks ties), or `undefined` when the run did not publish it.
Because step types do not retain the graph, the implicit result type is the union
of all step outputs plus `undefined`. Use `finalize: count` to require and return
one step's output with its exact type; it is shorthand for
`requireOutputs([count], ({ count }) => count)`. See the
[precise result recipe](../examples/precise-result.ts).

Each planned step carries `selectionReasons` explaining why it was selected or
omitted, and `selected` / `skipReason` (such as `filtered`, `dry-run`, or
`unmet-dependency`):

```ts
const plan = pipeline.plan({ targets: ["publish"] });
plan.steps.find((step) => step.id === "load")?.selectionReasons;
// [{ kind: "required-dependency", dependentId: "build", targetId: "publish" }]
```

Use the plan directly in applications; `tubeless plan` renders the same data.

### Required final outputs

Dry runs, exact filters, and failures can leave outputs missing. Use
`requireOutputs([stepA, stepB], callback)` when a valid result needs them: it
makes them required in the callback and fails finalization, naming the step, if
one is absent. A step that returns `undefined` still produced an output.

Tubeless also checks each declared target, including the implicit one, includes
the steps the finalizer requires (directly or through dependencies and gates).
Use a plain finalizer when selected goals may return partial results. If
independent finalizer inputs fall outside the implicit target closure, declare a
target that includes them or use `targets: []`.

## Step statuses and structured errors

```text
planned ──┬──> running ──┬──> complete
          │              ├──> skipped
          │              ├──> cancelled
          │              └──> failed
          ├──> skipped
          └──> cancelled
```

Every selected step ends in exactly one terminal report; cancellation is distinct
from failure. Hooks respond to changes: `onStepPlan`, `onStepStart`,
`onStepProgress`, `onStepComplete`, `onStepSkip`, `onStepCancel`, `onStepFail`,
and `onStepStatus` (every status, in addition to specific hooks).

Each hook gets its own copy of lifecycle metadata, so mutating it does not affect
execution. The domain `value` given to `onFinalizeComplete` and
`onPipelineComplete` is the original object; treat it as read-only. Hook
exceptions are logged and never fail the run.

Every `PipelineError` has `code`, `phase` (`definition`, `planning`, `execution`,
`finalization`), and `kind`. Branch on those, not message text. A thrown error's
own machine code is kept as `sourceCode`, and `Error.cause` chains become a
bounded, JSON-safe `PipelineErrorCause` tree.

```ts
const result = await pipeline.run(options);
const first = result.errors[0];

if (first?.code === "TUBELESS_STEP_FAILED" && first.sourceCode === "ENOENT") {
  // A step failed because its underlying operation could not find a file.
}
```

`runOrThrow` raises `PipelineExecutionError` with the full result on `result` and
the original thrown value on `cause`. `PipelineStepReport` describes a step's
final status: timing when it completed, `reason` and optional `dependencyId` when
skipped, a structured `error` when failed or cancelled.

## Versioned run records

`run()` returns one versioned `PipelineRun<TResult>` with a generated `runId`,
terminal `status`, timestamps, structured errors, and one report per planned
step. Pass `context.correlationId` for an external job identifier and
`context.parentRunId` only to link another Tubeless run ID.

`finalized` discriminates result presence: when `true`, `value` is `TResult`;
when `false`, it is `undefined`. Status and finalization are independent: a
failed best-effort run may still have a finalized partial value.

```ts
const run = await pipeline.run(options, { continueOnError: true });

if (run.finalized) {
  consume(run.value);
}
```

An executed step gets one `attemptId`, on its context, report, and trace records.
Structural skips and steps cancelled before starting have none.
`context.reportAttempt()` records retry progress without creating a new one.

The run report carries no logs or progress stream; use a logger and hooks for
live updates, or a trace exporter for later inspection. A failing
`tracing.exporter` never fails the run (a warning is logged once and later events
are dropped). `tubeless/tracing` exposes only the typed event union and exporter
composition (`composeTraceExporters`); concrete JSON or telemetry adapters belong
in your application. See the [tracing recipe](../examples/tracing.ts). The run
carries `version` (also `RUN_MODEL_VERSION`); persist it and branch on it before
decoding stored runs.

### Local event store and studio

To inspect runs after the process exits, the CLI writes a SQLite database with
`--store`, an NDJSON trace with `--trace`, or both. Use `tubeless history` in the
terminal or `tubeless ui` in a browser; see [the studio guide](./studio.md).
Importing `tubeless` never loads SQLite or the UI.

## Dry runs

Every step has one `run` handler and an optional dry-run policy:

- Omit `dryRun` when the normal handler is safe during a dry run.
- Set `dryRun: "skip"` for writes, database mutation, publication, email, and
  other side effects. The step is structurally skipped and its required
  dependents do not run.
- Provide `dryRun(inputs, context)` to substitute a side-effect-free preview. It
  must return the same output type as `run`.

```ts
const publish = step("publish", {
  dependsOn: [build],
  dryRun: ({ build }) => ({ id: `preview:${build.id}` }),
  run: ({ build }) => publishArtifact(build),
});
```

Dry run is not a rollback mechanism: unmarked read-only steps run normally.

## Validated boundaries

To check runtime values from files or requests, pass any Standard Schema V1
validator (no validation library is bundled): a domain-options schema to
`createSteps(schema)`, an `outputSchema` to a step, or a `resultSchema` to
`definePipeline`.

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

Schemas may transform values; TypeScript infers both sides.

| Schema         | Value it receives                                                        | Value available after validation |
| -------------- | ------------------------------------------------------------------------ | -------------------------------- |
| Options schema | The caller's domain options                                              | `context.options` in each step   |
| `outputSchema` | The step's return value, including custom dry-run and policy-skip values | Input to dependent steps         |
| `resultSchema` | The finalizer's return value                                             | The final pipeline result        |

- Run controls are separate from domain options, so strict schemas need no
  `dryRun` field and domain fields may be named `targets` or `maxConcurrency`.
- Options validate once after planning and before any step starts. Step values
  validate before publication; final values before the run is marked successful.
  `plan()` never invokes schemas.
- With no `finalize`, `resultSchema` validates the last step's output (possibly
  `undefined`), so a dry or filtered run may be rejected; supply a finalizer
  when the inferred union cannot satisfy the schema.
- Failures keep normalized `PipelineError.issues` and the codes
  `TUBELESS_OPTIONS_VALIDATION_FAILED`,
  `TUBELESS_STEP_OUTPUT_VALIDATION_FAILED`, and
  `TUBELESS_FINAL_RESULT_VALIDATION_FAILED`. A final-result failure reports step
  `__finalize__`.

See [`validated-boundaries.ts`](../examples/validated-boundaries.ts).

## Child pipelines

`fromPipeline` runs one reusable child pipeline; `forEachPipeline` runs it for
each item in a list. The parent plan shows one wrapper step with child activity
as nested progress. `skip` on either omits the whole child step (output may be
`undefined`). See [child-pipeline composition](./child-pipeline-composition.md).

## Remote steps

`fromRemote` calls a service or execution engine from one step while the parent
runs locally. Without a dry-run policy it still contacts the service during a
dry run: mark unsafe calls `dryRun: "skip"`, provide a local preview, or make
sure the service honors the flag. See
[remote-step composition](./remote-step-composition.md).

## Mermaid diagrams

`pipeline.toMermaid()` returns a static flowchart without running anything.
Required dependencies are solid arrows; optional inputs and failure gates are
labeled dotted arrows. Options include `direction` and `includeDescriptions`.

## CLI commands

Put schema-backed pipelines in `defineProject(id, pipelines)`, or export one from
a file, and the CLI infers arguments, validation, help, and progress. Use
`definePipelineCommand` for custom adapters. See [`cli-job.ts`](../examples/cli-job.ts)
and [the CLI guide](./cli.md).

Pipeline `name` and `description` are inherited by commands; command-level
values win. The pipeline ID remains the stable identity for lookup, selection,
traces, and history.

`tubeless inspect`, `plan`, and `graph` load a module without running handlers
or needing inputs, so keep module imports free of side effects. For a direct
file, `tubeless run` prefers an exported command and otherwise wraps one uniquely
selected schema-backed pipeline. Schema-less or unsupported input shapes need an
explicit command adapter. The [project example](../examples/project/tubeless.project.ts)
shows the custom-adapter layout.

Command-only values such as `resume`, `stepIds`, and `targets` are removed from
domain options before execution. The flags are `--resume`, `--step`, and
`--target`; option mappers and hooks use the parsed property names. `--resume`
exists only when the command configures managed `checkpoint` support or declares
`resume: true`.

Put CLI file-selection flags before `--` and pipeline arguments after it:

```sh
tubeless run --export PublishCommand ./scripts/publish.ts -- --source input.json --target publish
```

SIGINT and SIGTERM abort the run's signal, and distinct exit codes distinguish
validation, planning, execution, and cancellation errors.

## Runtime context

The step context supplies:

- `context.options` (validated domain options) and `context.dryRun`.
- `context.log`, for the active logger or reporter.
- `context.signal`, to pass cancellation to I/O.
- `context.sleep`, a cancellation-aware, testable delay.
- `context.reportProgress` and `context.reportAttempt` (retries).
- `context.cwd`, the base for relative paths.
- `context.checkpoint`, the command's managed checkpoint when configured. Child
  pipelines inherit it; a child previewed with `controls: { dryRun: true }`
  works on a copy, so a preview cannot mark work done.

Callers may inject the logger, clock, sleep, signal, hooks, and tracing, which
keeps pipelines embeddable and deterministic under test.

## Deterministic testing

`createPipelineTestRuntime` from `tubeless/testing` supplies a test clock, a
capturing logger, and hooks that record statuses and progress. Its default sleep
advances the clock immediately. Its `run`, `runOrThrow`, and `plan` call the real
pipeline. Create one runtime per test, call `test.abort()` to exercise
cancellation, and replace external I/O yourself; network and filesystem are not
mocked. See [`cancellation-and-testing.ts`](../examples/cancellation-and-testing.ts).

### Supplying step outputs

`overrideStep` from `tubeless/testing` supplies a typed intermediate value
without changing the pipeline:

```ts
const test = createPipelineTestRuntime();
const run = await test.run(pipeline, options, {
  stepIds: ["load", "summarize"],
  overrides: [overrideStep(load, ["alice", "bob"])],
});
```

- Pair an actual step reference with its handler output. For schema-backed steps,
  supply the **schema input** type; `outputSchema` still validates and
  transforms it. Functions are values, never lazy factories.
- A selected overridden step never calls `run`, `skip`, or `dryRun`, and
  bypasses required-input checks, failure gates, and `dryRun: "skip"`. Overriding
  a child, fan-out, or remote wrapper also skips its adapters and child launches.
- Overrides do not select steps or prune ancestors, and apply to that run only
  (not its children). To isolate a downstream branch, select exact `stepIds`
  that include the override and its dependents. Plans ignore overrides.
- Duplicate overrides and foreign step references (even same-named) reject
  before execution.
- Reports, hooks, and traces mark overridden steps with
  `outputSource: "override"`; the supplied value is not recorded.

Overrides exist only on the test runtime's `run` and `runOrThrow`, not in CLI
flags or Studio. See [`step-output-overrides.ts`](../examples/step-output-overrides.ts).
