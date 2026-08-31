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

| Need | Composition | Who drives the DAG | Who survives process death |
| --- | --- | --- | --- |
| The graph must outlive the process, sleep for days, or wait on humans | Host embedding: a Temporal workflow, Lambda handler, or queue worker calls `pipeline.runOrThrow(...)` and passes `runId` / `parentRunId` | The engine | The engine |
| Some steps run elsewhere; the rest stay local | `fromRemote`: one opaque parent step per remote unit of work | The tubeless process | Only the remote job, not the parent `PipelineRun` |

These are complementary. Embedding makes the *graph* durable. `fromRemote`
makes *a step* remote. Do not treat a remote invoker inside today's loop as
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
  invoke(
    payload: TPayload,
    context: PipelineStepContext<TOptions>
  ): Promise<TResult>;
}
```

`invoke` is request/response. Temporal start-then-`result()`, Lambda invoke,
HTTP RPC, and a queue that blocks until the job finishes all live inside the
adapter. The adapter maps:

- `context.signal` to cancel
- `context.reportProgress` to heartbeats or status polls
- `${context.runId}:<step-id>` to a job id when the engine needs one. The
  step id comes from the `fromRemote("enrich", …)` call site, usually via
  `mapInput`. `PipelineStepContext` does not grow a `stepId` field.
- `context.dryRun` to the engine's side-effect gate

`engine` is required so plan, inspect, and studio can label the step. Typical
values are `"lambda"`, `"temporal"`, `"http"`, or `"test"`. The kernel does not
validate the string.

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
`charge` stays local because charging is the side effect, not because Temporal
is remote.

### Built step

The factory attaches a private `STEP_REMOTE` symbol, parallel to
`STEP_NESTED_PIPELINE`, and builds a normal step:

- `run` calls `mapInput` then `adapter.invoke`
- `dryRun` is `"skip"`, a preview handler, or omitted
- `outputSchema` is the author-supplied schema

A step cannot be both nested and remote.

## Dry-run contract

Dry-run is a side-effect gate. It is not "run locally" vs "run remotely".

| Author writes | Meaning | Pipeline dry run |
| --- | --- | --- |
| omit | Work is safe, or the engine honors dry-run | Call `invoke`; `context.dryRun === true` |
| `dryRun: "skip"` | This work is the side effect | Do not call `invoke` |
| `dryRun: (inputs, ctx) => …` | A local preview is enough | Call the handler only |

`skipsInDryRun` already implements this: only `step.dryRun === "skip"` is a
structural skip. The factory does **not** stamp `"skip"`. Stamping it would
prevent rehearsing a remote path.

### Inverse contract (required)

A remote adapter that receives `context.dryRun === true` must not produce side
effects. The kernel does not inject `dryRun` into the payload and does not
inspect the engine. Authors prove the flag crossed the boundary by putting
`dryRun: ctx.dryRun` (or the engine's equivalent) in `mapInput`.

This is the same rule as a local step that omits `dryRun`: the handler owns
not writing when `context.dryRun` is true. The recipe and agent guide must
state this in the inverse: if the remote is contacted during a dry run, the
adapter and the remote worker must treat that as a rehearsal.

There is no way to call `invoke` while lying about dry-run. `context.dryRun`
is the pipeline's actual flag.

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

| Step `dryRun` | `remote` | Dry-run plan text |
| --- | --- | --- |
| `"run"` | present | `run -> remote lambda (enrich-v2); dry-run contacts engine` |
| `"skip"` | present | `skip: dry-run -> remote temporal (chargeOrder)` |
| `"custom"` | present | `run -> remote temporal (chargeOrder)` plus the usual custom policy |
| `"run"` | absent | today's ordinary `run` |

JSON and `PipelinePlan` stay machine-simple: `dryRun` plus optional `remote`.
Do not add a `"rehearse"` plan value.

Mermaid stays the parent-step graph. It does not gain remote node types.
Authors who want an engine hint on the diagram put it in `description` and
pass `includeDescriptions`.

Trace `step.planned` records serialize `remote` next to `nested_pipeline` so
a recorded dry run can still say it contacted Lambda. The run-store projector
and studio read that snapshot; they do not import an SDK or expand a remote
graph.

## Failure, cancel, and skip

| Event | Existing classification |
| --- | --- |
| Adapter throw | `TUBELESS_STEP_FAILED`, `kind: "step"` |
| Abort via `context.signal` | `TUBELESS_RUN_CANCELLED`, `kind: "cancellation"` |
| `outputSchema` rejection | `TUBELESS_STEP_OUTPUT_VALIDATION_FAILED`, `kind: "validation"` |
| Policy skip | `reason: "policy"`, same as `fromPipeline.skippable` |

No `TUBELESS_REMOTE_*` codes. No engine job IDs on `PipelineStepReport`. The
adapter may log or put a job id in progress `details`.

## Testing

No AWS or Temporal dependency.

- Unit tests construct pipelines with a fake adapter (`engine: "test"`).
- Assert dry-run omit calls `invoke` with `context.dryRun === true`.
- Assert `dryRun: "skip"` never calls `invoke`.
- Assert a preview handler never calls `invoke`.
- Assert plan metadata `{ engine, target }`.
- Assert adapter throws become ordinary step failures.
- Assert abort during `invoke` is cancellation.
- Type tests: `outputSchema` required; `skip` only on `fromRemote.skippable`;
  `dryRun: "run"` is a type error.

- Application and example modules may export a pipeline factory that accepts
  adapters so tests can pass a fake. Do not add injected runner overrides.

## Learning surface

| Document | Change |
| --- | --- |
| `docs/comparison.md` | Two-compositions table. Host embedding is the durable-graph path. `fromRemote` is mixed placement. |
| `docs/concepts.md` | Short remote-step section after child pipelines. Dry-run remains a side-effect gate. |
| `docs/remote-step-composition.md` | Living contract, same role as `child-pipeline-composition.md`. |
| `docs/agent-guide.md` | `fromRemote` primitive. Inverse dry-run contract: an adapter that sees `context.dryRun === true` must not produce side effects; put the flag in the payload. Host-embed when the graph must outlive the process. |
| `docs/recipes.md` | New recipe: mixed local + remote steps with a fake adapter. Host-embedding snippet that passes `runId`. |
| `examples/remote-steps.ts` | Compiled example: local parse, remote enrich (omit dry-run, payload carries `dryRun`), remote charge (`dryRun: "skip"`). |
| `skills/tubeless/SKILL.md` | No second copy of the rules; it already defers to the agent guide. |

The recipe states the inverse contract explicitly. A rehearsal that contacts
an engine is only correct when the remote worker is side-effect free under
that flag.

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

- `src/pipeline.test.ts` or a focused `src/remote-step.test.ts`
- `src/public-api.example.test.ts` — one `fromRemote` smoke through the package entry
- `examples/remote-steps.ts` plus a focused example test if the repo pattern needs it

`executePlannedRun` should not grow an engine branch. If a change there is
needed, it is a bug in the factory design.

## Out of scope later work

A placement driver (option 3 from the design discussion) would extract a
`PipelineDriver` that consumes a `PipelinePlan` plus a step-id registry and
emits the same lifecycle. That is how the DAG itself would survive process
death. It is a later optional package, not a flag on `run()`, and it is not
this slice.

Official engine adapters can wrap Temporal or Lambda later. They implement
`RemoteStepAdapter`. They do not change the kernel protocol.
