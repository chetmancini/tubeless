# Child-pipeline composition

Use a child pipeline when part of a workflow is useful on its own and should
also run inside a larger pipeline. Tubeless provides three step builders:

| Builder           | Use it to                                       | Step output                              |
| ----------------- | ----------------------------------------------- | ---------------------------------------- |
| `fromPipeline`    | Run one child pipeline                          | The child's final result                 |
| `forEachPipeline` | Run the same child pipeline for a list of items | An array of child results in input order |
| `iteratePipeline` | Repeat a child until a transition finishes      | The transition's final result            |

All three builders infer the child options and result types. They forward the
parent's runtime context and report child progress through the parent step.
Start with the [single-child example](../examples/child-pipeline.ts) or the
[fan-out example](../examples/fan-out-progress.ts).

## Repeat a child with bounded state transitions

Use `iteratePipeline` when the next child input depends on the previous result.
The [pagination example](../examples/iteration.ts) collects pages without an LLM:

```ts
const { iteratePipeline } = createSteps<Options>();
const pages = iteratePipeline("pages", {
  pipeline: PagePipeline,
  maxIterations: 100,
  initialState: () => ({ offset: 0 }),
  mapOptions: (state, _inputs, context) => ({
    source: context.options.source,
    offset: state.offset,
  }),
  transition: (page) =>
    page.done
      ? { kind: "finish", result: page.rows }
      : { kind: "next", state: { offset: page.nextOffset } },
});
```

`initialState(inputs, context)` runs once per selected invocation. Required
`dependsOn` outputs are available to initialization and mapping. Each child
finishes before `transition(result, state, context)` runs; transitions may be
asynchronous. State is read-only in mapping and transition types. Return fresh
state from initialization and `next`, and treat shared domain values as
read-only; generic iteration does not clone or serialize application state.

Return exactly `{ kind: "next", state }` or `{ kind: "finish", result }`.
The finish result, including a published `undefined`, is the step output.
Use `IterationDecision<State, Result>` for an explicit transition contract and
`finalize: pages` to require that exact result. Validate the final domain result
with the enclosing pipeline's `resultSchema` when needed.

`maxIterations` is a required positive safe integer, checked during authoring.
A finish on the last allowed child run succeeds. A next decision at the bound
fails the wrapper with `sourceCode: "TUBELESS_ITERATION_LIMIT_REACHED"`; no extra
child starts. Invalid transition data uses
`sourceCode: "TUBELESS_ITERATION_INVALID_DECISION"`. Child failures retain normal
child-error behavior and never reach the transition callback.
An exhausted iteration reports failed progress even though its child completed.

Static child `controls` use the existing child targets, selection, concurrency,
and failure policy. A parent's dry-run flag is always inherited. Omit the wrapper
dry-run policy to use child previews, or set `dryRun: "skip"` to skip the entire
iteration. A child whose required final result is structurally skipped fails
normally. Cancellation stops new iterations and drains the active child before
returning. Initializers, mappings, transitions, and domain schemas do not run
during `plan()` or graph rendering.

Plans retain one wrapper with `nestedPipeline.mode: "iterate"`, the declared
child steps, static controls, and the maximum iteration count. Future iterations
are not selectable step IDs. Each actual child gets a fresh run ID and a trace
relation containing the owning run, wrapper step/attempt, and one-based iteration
index. This relation belongs only to the directly repeated child; descendants
keep their `parentRunId` links, and nested iterations supply their own relation.
Live progress retains the latest 32 iteration groups, newest first, plus
an omitted-count row. The current iteration stays first so recorded progress
retains it when detail rows are truncated; traces preserve each child lifecycle.
Iteration adds no crash recovery.

## Run a child pipeline

Use `fromPipeline` with `pipeline`. When the parent's domain options satisfy the
child's input type, omit `mapOptions` to forward `context.options` unchanged:

```ts
const { fromPipeline } = createSteps<NormalizeOptions>();
const normalize = fromPipeline("normalize", { pipeline: NormalizePipeline });
```

Inherited options are the parent's validated, transformed options. The child
still validates them through its own input schema. All parent fields are forwarded;
use an explicit mapper to remove extra fields if the child schema rejects them.
Execution controls are separate and are never merged into these options. See the
[inherited inputs example](../examples/inherited-inputs.ts).

When the input types differ, `mapOptions` is required. It receives the parent
step's dependency outputs and context, and returns the inputs the child needs.
You can also supply it to override otherwise compatible inputs. Add `mapResult`
if the parent needs a different result shape.

```ts
const { fromPipeline } = createSteps<ImportOptions>();

const normalizedImport = fromPipeline("normalized-import", {
  pipeline: NormalizePipeline,
  mapOptions: (_inputs, context) => ({ rows: context.options.lines }),
  controls: { targets: ["normalize-rows"], maxConcurrency: 4 },
  mapResult: (rows) => ({ count: rows.length, rows }),
});
```

`mapOptions` returns only the child's domain inputs. Put child-specific
execution policy in `controls`, either as a value or as a callback with the
same `(inputs, context)` arguments as `mapOptions`.

## Run a child for each item

Use `items` to return the list to process, `key` for stable item IDs, and
`concurrency` to limit simultaneous child runs. `forEachPipeline` always requires
an explicit per-item `mapOptions`:

```ts
const { forEachPipeline } = createSteps<ParentOptions>();

const processShards = forEachPipeline("process-shards", {
  pipeline: ShardPipeline,
  dependsOn: [resolveShards],
  items: ({ "resolve-shards": shards }) => shards,
  key: (shard) => shard.id,
  concurrency: (_inputs, context) => context.options.concurrency,
  // Optional presentation only. Defaults to the noun "items".
  progress: { itemNoun: "shards" },
  controls: (shard) => ({
    targets: shard.publish ? ["publish"] : ["build"],
    maxConcurrency: 4,
  }),
  mapOptions: (shard, _index, _inputs, context) => ({
    shardPath: shard.path,
    outputRoot: context.options.outputRoot,
  }),
});
```

A fan-out `controls` callback receives
`(item, index, inputs, context)`, so each child can select its own targets or
scheduling policy without putting those fields in its domain options.

To skip the whole step when there are no items, add `skip` to its definition:

```ts
const { forEachPipeline } = createSteps<ParentOptions>();

const processShards = forEachPipeline("process-shards", {
  pipeline: ShardPipeline,
  dependsOn: [resolveShards],
  skip: ({ "resolve-shards": shards }) =>
    shards.length === 0 ? { reason: "no shards selected", value: [] } : false,
  items: ({ "resolve-shards": shards }) => shards,
  key: (shard) => shard.id,
  mapOptions: (shard) => ({ shardPath: shard.path }),
});
```

## Results and type inference

Without `mapResult`, a `fromPipeline` step returns the child's final result.
With `mapResult`, it returns the mapped value. An asynchronous mapper is awaited
before the value becomes available to dependent steps. Its policy-skip value,
if supplied, must match that resolved result type.

`forEachPipeline` returns results in input order, even when child runs finish
in a different order. `concurrency` limits the number of child runs in flight.
Keys must be stable and unique; duplicate keys fail before any child starts.
All running children finish or cancel before the parent step returns a failure.
The parent therefore cannot finalize while those children are still running.

Add `skip` to a `fromPipeline` or `forEachPipeline` definition when the entire
child step may be intentionally omitted. The callback returns `false` to proceed,
a non-empty reason string to skip, or `{ reason, value }` to skip with an output.
A skip without a value publishes `undefined`. Policy skips allow required
dependents to run, so those dependents must handle `undefined` when any skip
branch omits its value.

Without `skip`, `fromPipeline` returns `T` and `forEachPipeline` returns
`readonly T[]`. A skip that can omit its value widens those types to
`T | undefined` and `readonly T[] | undefined`. When every skip branch supplies
a value, the original type is preserved. For fan-out, the skip value is the
complete result array. Skipping does not call `items`, run children, or apply
`mapResult`.

## Planning and execution controls

The parent plan contains one step for the child workflow. This is what
"opaque" means in the API: child steps are not added to `PipelinePlan.steps`.
The parent's `nestedPipeline` metadata still identifies the child pipeline,
its declared step IDs, and whether it runs once or for multiple items.

Selecting the parent step runs the child using mapped inputs, or inherited parent
options for `fromPipeline` without a mapper. Parent and child step IDs are separate. A parent target does not
select an identically named child step, and `parent.child-step` selection is
not supported.

| Control           | Child behavior                                                                                |
| ----------------- | --------------------------------------------------------------------------------------------- |
| `dryRun`          | A child can enable it; a dry-running parent always forces it to `true`                        |
| `stepIds`         | Uses only the child-specific value supplied by `controls`                                     |
| `targets`         | Uses only the child-specific value supplied by `controls`; IDs must be declared child targets |
| `maxConcurrency`  | Uses only the value supplied by `controls`; defaults to `1` per child run                     |
| `continueOnError` | Uses only the value supplied by `controls`                                                    |

Domain properties may use the same names without collision: a child option
named `targets` remains in `context.options.targets`, while `controls.targets`
selects child work. An invalid child plan fails the parent step before child
execution begins.

In a dry run, each child step still follows its own policy. Mark child writes
with `dryRun: "skip"` or provide a side-effect-free preview handler. You can
also set a dry-run policy on the parent wrapper step to skip or preview the
whole child workflow.

Composition adds no checkpoints or crash recovery. Fan-out runs children
concurrently within one parent step; it does not make the parent graph execute
its steps in parallel. Opt in to parent DAG parallelism with the parent run's
`maxConcurrency` control. Each wrapper occupies one parent slot for its full
lifetime, while child DAG limits and fan-out item concurrency apply independently.
Four parallel parent steps, each with fan-out `concurrency: 8`, can create 32 active
children. Increasing each child's `maxConcurrency` can multiply active child steps
again. The CLI's `--max-concurrency` controls the parent run only; it is not inherited
by children. Set child controls explicitly with `controls` when needed.

There is no shared parent/child semaphore. A parent holding a shared slot while
waiting for children that need the same slots could deadlock.

## Failures and cancellation

A child must finish with status `"completed"` to provide a successful parent
step output. `continueOnError` can let independent child work finish, but a
failed child still fails the parent step. Successful siblings in a failed
fan-out do not produce a partial parent-step output.

Child failures use `code: "TUBELESS_CHILD_FAILED"`, `phase: "execution"`, and
`kind: "child"`. The error identifies the child pipeline and first failing
step, and includes a JSON-safe cause chain. For multiple child runs, failure
takes precedence over cancellation: the parent step is cancelled only when
every unsuccessful child was cancelled.

Children receive the parent's exact `AbortSignal`. They must pass it to their
I/O and other cancellable work. The adapter waits for running children to
finish or cancel before returning.

If partial child results are valid for your application, use an ordinary step
that calls the child's `run()` and explicitly handles its report. Supply an
appropriate child context; do not forward the parent's raw hooks or progress
callback, which belong to the parent run's reporter.

## Progress and hooks

The builders forward the parent's working directory, logger, clock, sleep
function, and abort signal. Parent hooks observe the parent step. Child hooks
are handled internally and converted into progress updates on that step.
This keeps parent and child reporting separate.

The interactive CLI displays `fromPipeline` child steps beneath the parent.
For `forEachPipeline`, it adds an item-key row above each child's steps.
Completed rows remain visible; failed, cancelled, and skipped rows keep their
own statuses. Filtered steps are omitted. Nested progress counts and details
are preserved, so a child can report progress inside a long-running step.

The parent progress count advances as child steps reach a terminal state.
For fan-out, `completed` counts finished child steps across items, and `total`
is the number of items multiplied by the number of child steps. Use
`progress.itemNoun` or `progress.formatMessage` to change labels and summaries
without changing execution.

### Display and trace limits

Live fan-out updates show up to 32 item groups by default. Active items and
failures take priority, and displayed groups remain in input order. An overflow
row shows the number of omitted groups. All groups are retained, and a complete
tree is emitted when the fan-out finishes. Set `progress.detailLimit` to change
the live limit; this also limits the final snapshot.

The CLI shows a scrolling window when the tree is taller than the terminal and
prints the retained tree at completion. Non-interactive output uses summary
messages. Progress data is not built when neither hooks nor tracing observe it.
Custom renderers can read `details` as rows ordered parent before child.
`depth: 0` (or no depth) identifies a direct child; each nested level adds one.
IDs are stable within their group, and `name` is an optional label. Row
`completed` and `total` values describe work inside the child, independently
of the parent's count of finished steps. CLI indentation is capped at 32 levels.

Recorded trace snapshots have separate limits: 128 rows, 4096 characters per
field, and a 256 KiB encoded payload. `detailCount` records the row count before
truncation. The byte limit includes UTF-8 encoding and JSON escaping, leaving
space for event metadata within the default 1 MiB NDJSON event limit.

## Structured fan-out failures

A failed or cancelled `forEachPipeline` step exposes `error.fanOut` on the parent
run error and step report (also available to failure hooks, JSON error rendering, and recorded trace history).
`failures` contains at most the first 32 failed started items in input order,
with the original `index`, `key`, `keyTruncated`, `cancelled`, and a JSON-safe
`error` cause snapshot. `failureCount` counts all failed started items;
`omittedFailureCount` counts entries beyond the limit. Scheduler failures appear
separately as `schedulerError`; unstarted items are not failures. Setup errors,
such as duplicate keys or an exception in `items`, have no `fanOut` diagnostic.

Keys and snapshot strings are capped at 1024 UTF-16 code units, and cause chains
use the existing eight-level bound. `keyTruncated` explicitly marks shortened
keys; use the original input index to recover those identities. Snapshots retain
messages, names, source codes, and causes, without stacks, options, successful
outputs, or nested run objects. Nested fan-outs do not recursively expand here.

Use complete keys to select original inputs for a caller-directed rerun. Check
`omittedFailureCount` before treating the list as exhaustive, and account for
unstarted work after cancellation. Reruns are ordinary new pipeline runs; the
caller owns retry policy and side-effect safety. See the helper in
[`fan-out-progress.ts`](../examples/fan-out-progress.ts).

The diagnostics describe which items failed; they do not retry work or change
the parent step's failure behavior.
