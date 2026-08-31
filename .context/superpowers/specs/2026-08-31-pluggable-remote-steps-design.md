# Pluggable remote steps

Tubeless stays an in-process typed DAG. Some steps need to run on Temporal,
Lambda, an HTTP RPC, or another engine. This spec adds one kernel composition
for that case and documents the host-embedding composition that already works.

## Problem

`pipeline.run()` always calls `executePlannedRun`, which walks a topo-sorted
list in one process and invokes `step.run` against an in-memory output map.
Observation is already pluggable (`PipelineTraceExporter`, SQLite, studio).
Execution is not.

People already embed a whole pipeline in a Temporal workflow, Lambda handler,
or queue worker by calling `pipeline.runOrThrow(...)`. That keeps every
tubeless benefit for the graph, but it treats the DAG as one engine unit.

The missing piece is mixed placement: parse locally, enrich on Lambda, charge
on Temporal, notify over HTTP, still one parent plan, one `PipelineRun`, one
dry-run / skip / target model.

## Goals

- Let one parent DAG place different steps on different engines.
- Keep typed tokens, `definePipeline` graph checks, `plan()`, dry-run, targets,
  hooks, and `PipelineRun` in the kernel.
- Keep the kernel dependency-free. Engine SDKs stay in the app or a later
  optional package.
- Treat dry-run as a side-effect gate, not a locality gate.
- Document host embedding so durable-graph users do not invent a second
  runtime.

## Non-goals

- A placement driver that compiles the DAG into a Temporal workflow.
- Crash-resume of the parent process. If Node dies mid-wait, completed remote
  jobs have no tubeless scheduler to fold them into `PipelineRun`.
- An `engine` enum or switch on `AnyStep`.
- Temporal, AWS, or HTTP SDKs in the kernel.
- Flattening remote activity, workflow, or request IDs into the parent DAG.
- Injected runner overrides (same rejection as child pipelines).
- `fromRemote` `mapResult`. Reshape in the adapter or a later local step.
- Official `tubeless-temporal` / `tubeless-lambda` packages in this slice.

## Two compositions

| Need                                                                  | Composition                                                                                                                              | Who drives the DAG   | Who survives process death                        |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | ------------------------------------------------- |
| The graph must outlive the process, sleep for days, or wait on humans | Host embedding: a Temporal workflow, Lambda handler, or queue worker calls `pipeline.runOrThrow(...)` and passes `runId` / `parentRunId` | The engine           | The engine                                        |
| Some steps run elsewhere; the rest stay local                         | `fromRemote`: one opaque parent step per remote unit of work                                                                             | The tubeless process | Only the remote job, not the parent `PipelineRun` |

These are complementary. Embedding makes the _graph_ durable. `fromRemote`
makes _a step_ remote. Do not treat a remote invoker inside today's loop as
crash-resume.

`docs/comparison.md` already says a queue worker or durable step can call
`pipeline.runOrThrow`. This slice expands that into the table above and adds a
short recipe that passes `runId`.

## Architecture

```text
createSteps / definePipeline / plan / decideStepDisposition / PipelineRun
        │
        ▼
   step.fromRemote(...)     kernel: dry-run, cancel, outputSchema, plan metadata
        │
        ▼
   RemoteStepAdapter        protocol only; no SDK
        │
   ┌────┼────────────┐
   ▼    ▼            ▼
 Lambda  Temporal   RPC/HTTP
```

`fromRemote` is the same kind of factory as `fromPipeline`: one parent step,
typed dependencies, local plan, engine work hidden behind a protocol.

`executePlannedRun` does not learn about engines. The factory builds an
ordinary `AnyStep` whose `run` maps input and calls `adapter.invoke`. Existing
disposition, output validation, hooks, and reports apply unchanged.

## API

### Adapter protocol

```ts
interface RemoteStepAdapter<TOptions extends object, TPayload, TResult> {
  /** Presentation only. The kernel never switches on this. */
  readonly engine: string;
  /** Function name, workflow type, URL, queue. Presentation only. */
  readonly target?: string;
  invoke(payload: TPayload, context: PipelineStepContext<TOptions>): Promise<TResult>;
}
```

`invoke` is request/response. Temporal start-then-`result()`, Lambda invoke,
HTTP RPC, and a queue that blocks until the job finishes all live inside the
adapter. The adapter maps:

- `context.signal` to cancel
- `context.reportProgress` to heartbeats or status polls
- `context.log` to remote output when the engine can stream or poll it
- `${context.runId}:<step-id>` to a job id when the engine needs one. The
  step id comes from the `fromRemote("enrich", …)` call site, usually via
  `mapInput`. `PipelineStepContext` does not grow a `stepId` field.
- `context.dryRun` to the engine's side-effect gate
- remote failures to a thrown `Error` so the kernel can wrap them

`engine` is required so plan, inspect, and studio can label the step. Typical
values are `"lambda"`, `"temporal"`, `"http"`, or `"test"`. The kernel does not
validate the string.

#### Inverse dry-run contract (required)

Omitting `dryRun` on `fromRemote` means the adapter is contacted during a
pipeline dry run. That makes this adapter-side rule the only safety line:

- When `context.dryRun === true`, `invoke` must not produce side effects.
- The remote worker must treat the same flag the same way.
- The kernel does not inject `dryRun` into the payload and does not inspect
  the engine. Authors prove the flag crossed the boundary by putting
  `dryRun: ctx.dryRun` (or the engine's equivalent) in `mapInput`.
- There is no way to call `invoke` while lying about dry-run.
  `context.dryRun` is the pipeline's actual flag.

This is the same rule as a local step that omits `dryRun`: the handler owns
not writing when `context.dryRun` is true. An adapter that ignores the flag
is incorrect, not a kernel gap.

#### Local visibility (logs optional, exceptions required)

Remote work stays one opaque parent step. Local studio, hooks, and the TTY
already observe that step. Adapters optionally forward telemetry into those
seams; the kernel does not grow a second protocol, a `streamLogs` flag on
`fromRemote`, or a CloudWatch / Temporal tail.

**Logs are optional.** If the engine can stream or poll output while
`invoke` is in flight, the adapter calls `context.log.log` / `warn` /
`error` as lines arrive. Those already go to the injected logger. With
tracing or `--store` they become correlated `pipeline.log` events that
studio pages under the parent step. If the engine has no stream, skip it.
`invoke` stays request/response: the adapter may poll inside the wait, but
it does not change the factory contract.

**Exceptions are required.** Do not swallow a remote failure. Rethrow an
`Error`. Wrap the remote object as `cause`. Copy a machine `code` onto the
thrown error when the engine has one. Existing `toPipelineError` wrapping
then produces `TUBELESS_STEP_FAILED` with `message`, `stack`, bounded
`cause`, and `sourceCode`. Cancellation still goes through
`context.signal` and becomes `TUBELESS_RUN_CANCELLED`. No
`TUBELESS_REMOTE_*` codes.

**Progress is the latest heartbeat; logs are the append-only narrative.**
Use `context.reportProgress` for status and a job-id detail row. Use
`context.log` for lines. Both can run together. Do not flatten remote log
lines into child steps.

Adapters must not dump unbounded remote files. Trace strings and progress
details already have bounds (`TRACE_STRING_LIMIT`, `TRACE_LIST_LIMIT`);
forwarded lines go through the same logger and inherit those limits.

A dry-run rehearsal may stream logs. The inverse contract still holds:
`invoke` must not produce side effects when `context.dryRun === true`.

### Factory

`createSteps().fromRemote(...)` sits on `StepFactory` next to `fromPipeline`.

Required fields:

- `adapter`
- `mapInput(inputs, context) => payload`
- `outputSchema`

This is an untrusted process boundary, which is already when tubeless requires
a schema. `mapInput` and `invoke` both receive `PipelineStepContext<TOptions>`.
Dependents see `InferSchemaOutput<typeof outputSchema>`.

Optional fields, same as today:

- `dependsOn` / `optionalDependsOn` / `skipAfterFailureOf`
- `name`, `description`
- `dryRun`: `"skip"` or a typed preview handler
- `fromRemote.skippable` with the same `TOut | undefined` widening as
  `fromPipeline.skippable`

Authors do not write `dryRun: "run"`. That token is not part of the authoring
surface. Omitting `dryRun` already means the step's work runs, including during
a pipeline dry run.

```ts
const enrich = step.fromRemote("enrich", {
  dependsOn: [parse],
  adapter: lambdaAdapter({ functionName: "enrich-v2" }),
  mapInput: ({ parse }, ctx) => ({
    rows: parse.rows,
    runId: ctx.runId,
    dryRun: ctx.dryRun,
  }),
  outputSchema: enrichResultSchema,
});

const charge = step.fromRemote("charge", {
  dependsOn: [enrich],
  adapter: temporalAdapter({ workflowType: "chargeOrder" }),
  mapInput: ({ enrich }) => ({ orderId: enrich.orderId }),
  outputSchema: chargeResultSchema,
  dryRun: "skip",
});
```

`enrich` contacts Lambda during a dry run so the remote path can be rehearsed.
The payload carries `dryRun: true`; the adapter and the function must not
mutate. `charge` stays local because charging is the side effect, not because
Temporal is remote.

### Built step

The factory attaches a private `STEP_REMOTE` symbol, parallel to
`STEP_NESTED_PIPELINE`, and builds a normal step:

- `run` calls `mapInput` then `adapter.invoke`
- `dryRun` is `"skip"`, a preview handler, or omitted
- `outputSchema` is the author-supplied schema

A step cannot be both nested and remote.

## Dry-run policy

Dry-run is a side-effect gate. It is not "run locally" vs "run remotely".

| Author writes                | Meaning                                    | Pipeline dry run                         |
| ---------------------------- | ------------------------------------------ | ---------------------------------------- |
| omit                         | Work is safe, or the engine honors dry-run | Call `invoke`; `context.dryRun === true` |
| `dryRun: "skip"`             | This work is the side effect               | Do not call `invoke`                     |
| `dryRun: (inputs, ctx) => …` | A local preview is enough                  | Call the handler only                    |

`skipsInDryRun` already implements this: only `step.dryRun === "skip"` is a
structural skip. The factory does **not** stamp `"skip"`. Stamping it would
prevent rehearsing a remote path that is itself side-effect free.

The adapter-side half of this table is the inverse contract in the protocol
section. If the remote is contacted during a dry run, the adapter and the
remote worker must treat that as a rehearsal.

## Plan, inspect, and studio

`stepToPlanStep` copies `STEP_REMOTE` onto:

```ts
remote?: { engine: string; target?: string }
```

This is presentation, not flattening. Inspect, `renderPipelinePlan`, studio,
and stored history compose `dryRun` + `remote` the same way they already
compose `dryRun` + `nestedPipeline`.

The existing plan enum stays `"custom" | "run" | "skip"`. When `dryRun` is
omitted, `stepToPlanStep` already reports `"run"`. Renderers may say that a
dry run contacts the engine when all of these are true:

- the plan itself is a dry run (`PipelinePlan.dryRun === true`)
- the step policy is `"run"`
- `remote` is present
- the step is selected and not otherwise skipped

Suggested human text:

| Step `dryRun` | `remote` | Dry-run plan text                                                   |
| ------------- | -------- | ------------------------------------------------------------------- |
| `"run"`       | present  | `run -> remote lambda (enrich-v2); dry-run contacts engine`         |
| `"skip"`      | present  | `skip: dry-run -> remote temporal (chargeOrder)`                    |
| `"custom"`    | present  | `run -> remote temporal (chargeOrder)` plus the usual custom policy |
| `"run"`       | absent   | today's ordinary `run`                                              |

JSON and `PipelinePlan` stay machine-simple: `dryRun` plus optional `remote`.
Do not add a `"rehearse"` plan value. Do not add an authoring `dryRun: "run"`
token; the plan field `"run"` is the existing derived enum for omitted policy.

Mermaid stays the parent-step graph. It does not gain remote node types.
Authors who want an engine hint on the diagram put it in `description` and
pass `includeDescriptions`.

Trace `step.planned` records serialize `remote` next to `nested_pipeline` so
a recorded dry run can still say it contacted Lambda. The run-store projector
and studio read that snapshot; they do not import an SDK or expand a remote
graph.

## Failure, cancel, and skip

| Event                      | Existing classification                                        |
| -------------------------- | -------------------------------------------------------------- |
| Adapter throw              | `TUBELESS_STEP_FAILED`, `kind: "step"`                         |
| Abort via `context.signal` | `TUBELESS_RUN_CANCELLED`, `kind: "cancellation"`               |
| `outputSchema` rejection   | `TUBELESS_STEP_OUTPUT_VALIDATION_FAILED`, `kind: "validation"` |
| Policy skip                | `reason: "policy"`, same as `fromPipeline.skippable`           |

No `TUBELESS_REMOTE_*` codes. No engine job IDs on `PipelineStepReport`. The
adapter may log or put a job id in progress `details`. A remote object thrown
as `cause` with a `code` field becomes the ordinary bounded `cause` /
`sourceCode` snapshot; the kernel does not special-case remote errors.

## Testing

No AWS or Temporal dependency.

- Unit tests construct pipelines with a fake adapter (`engine: "test"`).
- Assert dry-run omit calls `invoke` with `context.dryRun === true`.
- Assert `dryRun: "skip"` never calls `invoke`.
- Assert a preview handler never calls `invoke`.
- Assert plan metadata `{ engine, target }`.
- Assert adapter throws become ordinary step failures.
- Assert a thrown `Error` with `cause` and `code` keeps the bounded cause
  chain and `sourceCode` on `TUBELESS_STEP_FAILED`.
- Assert `context.log` calls made from `invoke` reach the injected logger
  and, with tracing, a `pipeline.log` event on the parent step.
- Assert abort during `invoke` is cancellation.
- Type tests: `outputSchema` required; `skip` only on `fromRemote.skippable`;
  `dryRun: "run"` is a type error.

Application and example modules may export a pipeline factory that accepts
adapters so tests can pass a fake. Do not add injected runner overrides.

## Public surface and learning surface (this slice)

`fromRemote` and `RemoteStepAdapter` are public API. Regenerating the checked
inventory and updating the learning surface are part of this slice, not
follow-ups.

| Artifact                          | Required change                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/pipeline.ts`                 | Export `RemoteStepAdapter` with the other public types. `StepFactory` already re-exports from `pipeline-steps.ts`.                                                                                                                                                                                                                                                 |
| `bun run api:generate`            | Rebuild `docs/api-reference.md` and `docs/api-report.json` after the export lands. `make check` runs `api:check`.                                                                                                                                                                                                                                                  |
| `docs/recipes.md`                 | New rows: mixed local + remote steps; host embedding that passes `runId`.                                                                                                                                                                                                                                                                                          |
| `docs/agent-guide.md`             | Primitive: `fromRemote` for a unit of work that lives on another engine; inverse dry-run contract; host-embed when the graph must outlive the process. Plan metadata: parent plans expose `remote` with `engine` and optional `target`. Adapters may forward remote lines through `context.log` and must rethrow remote failures as `Error` with `cause` / `code`. |
| `examples/catalog/`               | Catalog-shaped pipeline + `definePipelineCommand` that uses `fromRemote` with a fake adapter, kebab-case IDs, and a studio registration in `tubeless.studio.ts`. Agents copy layout from this catalog.                                                                                                                                                             |
| `docs/comparison.md`              | Two-compositions table. Host embedding is the durable-graph path. `fromRemote` is mixed placement.                                                                                                                                                                                                                                                                 |
| `docs/concepts.md`                | Short remote-step section after child pipelines. Dry-run remains a side-effect gate.                                                                                                                                                                                                                                                                               |
| `docs/remote-step-composition.md` | Living contract, same role as `child-pipeline-composition.md`.                                                                                                                                                                                                                                                                                                     |
| `docs/README.md`                  | Link the composition doc from Deeper reference.                                                                                                                                                                                                                                                                                                                    |
| `docs/llms.txt`                   | Advanced link plus executable example path.                                                                                                                                                                                                                                                                                                                        |
| `examples/remote-steps.ts`        | Compiled recipe: local parse, remote enrich (omit dry-run, payload carries `dryRun`), remote charge (`dryRun: "skip"`).                                                                                                                                                                                                                                            |
| `src/public-api.example.test.ts`  | One `fromRemote` smoke through the package entry.                                                                                                                                                                                                                                                                                                                  |
| `skills/tubeless/SKILL.md`        | No second copy of the rules; it already defers to the agent guide.                                                                                                                                                                                                                                                                                                 |

The recipe and agent guide state the inverse contract explicitly. A rehearsal
that contacts an engine is only correct when the remote worker is side-effect
free under that flag.

A new agent-evaluation case is not required for this slice. Existing gated
cases stay as they are.

## Implementation sketch

Kernel (no new npm dependencies, no new public entrypoint):

- `src/pipeline-types.ts` — `RemoteStepAdapter`, `PipelinePlanStep.remote`
- `src/pipeline-plan.ts` — `STEP_REMOTE`; copy onto plan steps
- `src/pipeline-steps.ts` — `fromRemote` / `fromRemote.skippable`
- `src/pipeline.ts` — export the new types
- `src/render.ts` — human plan suffix for `remote`
- `src/tracing-internal.ts` — serialize `remote` on `step.planned`
- `src/run-store.ts` — parse and retain `remote` on stored steps/definitions
- `src/run-store-ui-page.ts` — "Remote step" kind, engine/target label

Tests and examples:

- `src/remote-step.test.ts` (or a focused section in `src/pipeline.test.ts`)
- `src/public-api.example.test.ts`
- `examples/remote-steps.ts` plus a focused example test if the repo pattern
  needs it
- `examples/catalog/pipelines/enrich.ts`, `examples/catalog/scripts/enrich.ts`,
  and a `tubeless.studio.ts` registration

`executePlannedRun` should not grow an engine branch. If a change there is
needed, it is a bug in the factory design.

After the public types export, run `bun run api:generate` in the same change.

## Out of scope later work

A placement driver (option 3 from the design discussion) would extract a
`PipelineDriver` that consumes a `PipelinePlan` plus a step-id registry and
emits the same lifecycle. That is how the DAG itself would survive process
death. It is a later optional package, not a flag on `run()`, and it is not
this slice.

Official engine adapters can wrap Temporal or Lambda later. They implement
`RemoteStepAdapter`. They do not change the kernel protocol.
