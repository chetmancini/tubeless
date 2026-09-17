# Child-pipeline composition

Use a child pipeline when part of a workflow is useful on its own and should
also run inside a larger pipeline. Tubeless provides two step builders:

| Builder           | Use it to                                       | Step output                              |
| ----------------- | ----------------------------------------------- | ---------------------------------------- |
| `fromPipeline`    | Run one child pipeline                          | The child's final result                 |
| `forEachPipeline` | Run the same child pipeline for a list of items | An array of child results in input order |

Both builders infer the child options and result types. They forward the
parent's runtime context and report child progress through the parent step.
Start with the [single-child example](../examples/child-pipeline.ts) or the
[fan-out example](../examples/fan-out-progress.ts).

## Run a child pipeline

Use `fromPipeline` with `pipeline` and `mapOptions`. The mapper receives the
parent step's dependency outputs and context, and returns the inputs the child
needs. Add `mapResult` if the parent needs a different result shape.

```ts
const seedIndexStage = fromPipeline("seed-index", {
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

## Run a child for each item

Use `items` to return the list to process, `key` for stable item IDs, and
`concurrency` to limit simultaneous child runs:

```ts
const processShards = forEachPipeline("process-shards", {
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

To skip the whole step when there are no items, add `skip` to its definition:

```ts
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
dependents to run, so those dependents must handle `undefined` explicitly.

Without `skip`, `fromPipeline` returns `T` and `forEachPipeline` returns
`readonly T[]`. Adding `skip` widens those types to `T | undefined` and
`readonly T[] | undefined`. For fan-out, the skip value is the complete result
array. Skipping does not call `items`, run children, or apply `mapResult`.

## Planning and execution controls

The parent plan contains one step for the child workflow. This is what
"opaque" means in the API: child steps are not added to `PipelinePlan.steps`.
The parent's `nestedPipeline` metadata still identifies the child pipeline,
its declared step IDs, and whether it runs once or for multiple items.

Selecting the parent step runs the child using the values returned by
`mapOptions`. Parent and child step IDs are separate. A parent target does not
select an identically named child step, and `parent.child-step` selection is
not supported.

| Control           | Child behavior                                                                                |
| ----------------- | --------------------------------------------------------------------------------------------- |
| `dryRun`          | Always takes the parent's value, overriding any value in `mapOptions`                         |
| `stepIds`         | Uses only a child-specific value supplied by `mapOptions`                                     |
| `targets`         | Uses only a child-specific value supplied by `mapOptions`; IDs must be declared child targets |
| `continueOnError` | Uses only a value supplied by `mapOptions`                                                    |

Child `mapOptions` returns domain inputs and any child-specific controls in
one object. The adapter separates them before invoking the child. An invalid
child plan fails the parent step before child execution begins.

In a dry run, each child step still follows its own policy. Mark child writes
with `dryRun: "skip"` or provide a side-effect-free preview handler. You can
also set a dry-run policy on the parent wrapper step to skip or preview the
whole child workflow.

Composition adds no checkpoints or crash recovery. Fan-out runs children
concurrently within one parent step; it does not make the parent graph execute
its steps in parallel.

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
