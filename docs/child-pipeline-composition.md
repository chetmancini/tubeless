# Child-pipeline composition

Use a child pipeline when part of a workflow is useful on its own and should also
run inside a larger pipeline. Three step builders infer child options and result
types, forward the parent's runtime context, and report child progress through the
parent step:

| Builder           | Use it to                                       | Step output                                                                                  |
| ----------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `fromPipeline`    | Run one child pipeline                          | The child's final result                                                                     |
| `forEachPipeline` | Run the same child pipeline for a list of items | An array of child results in input order, or settled entries with `onItemFailure: "collect"` |
| `iteratePipeline` | Repeat a child until a transition finishes      | The transition's final result                                                                |

Start with the [single-child example](../examples/child-pipeline.ts) or the
[fan-out example](../examples/fan-out-progress.ts).

## Run a child pipeline

With `fromPipeline`, omit `mapOptions` to forward `context.options` unchanged when
the parent's options satisfy the child's input type. The child still validates them
through its own input schema, and all parent fields are forwarded, so use a mapper
if the child rejects extra fields ([inherited inputs](../examples/inherited-inputs.ts)):

```ts
const { fromPipeline } = createSteps<NormalizeOptions>();
const normalize = fromPipeline("normalize", { pipeline: NormalizePipeline });
```

When input types differ, `mapOptions` is required (it may also override compatible
inputs). It receives the step's dependency outputs and context. Add `mapResult` to
reshape the result; an async mapper is awaited before dependents see the value.

```ts
const { fromPipeline } = createSteps<ImportOptions>();

const normalizedImport = fromPipeline("normalized-import", {
  pipeline: NormalizePipeline,
  mapOptions: (_inputs, context) => ({ rows: context.options.lines }),
  controls: { targets: ["normalize-rows"], maxConcurrency: 4 },
  mapResult: (rows) => ({ count: rows.length, rows }),
});
```

`mapOptions` returns only domain inputs. Child execution policy goes in `controls`,
as a value or a callback with the same arguments as `mapOptions`.

## Run a child for each item

`items` returns the list, `key` gives stable unique item IDs (duplicates fail before
any child starts), and `concurrency` caps simultaneous children (positive finite
integer, default `1`). `mapOptions` is always required per item:

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

A `controls` callback receives `(item, index, inputs, context)`. Results come back
in input order regardless of completion order. A per-item `mapResult` is awaited and
a rejection fails that item. Running children always finish or cancel before the
parent step returns a failure.

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

- `initialState(inputs, context)` runs once; `dependsOn` outputs are available to it
  and to mapping. `transition(result, state, context)` runs after each child and may
  be async. State is typed read-only and is not cloned, so return fresh state and
  treat shared values as read-only.
- Return exactly `{ kind: "next", state }` or `{ kind: "finish", result }`; the
  finish result (even `undefined`) is the step output. `IterationDecision<State,
  Result>` types the contract, and `finalize: pages` requires that exact result.
- `maxIterations` is a required positive safe integer. Finishing on the last allowed
  run succeeds; a `next` at the bound fails with
  `sourceCode: "TUBELESS_ITERATION_LIMIT_REACHED"` and starts no extra child. An
  invalid decision fails with `sourceCode: "TUBELESS_ITERATION_INVALID_DECISION"`.
  Child failures never reach `transition`.
- Static `controls` work as for `fromPipeline`; a parent dry run is always inherited
  (set the wrapper `dryRun: "skip"` to skip the whole iteration). Cancellation stops
  new iterations and drains the active child. Callbacks do not run during `plan()`.
- The plan has one wrapper (`nestedPipeline.mode: "iterate"`); future iterations are
  not selectable step IDs. Each child gets a fresh run ID, and live progress keeps
  the latest 32 iteration groups, newest first.

Iteration adds no crash recovery.

## Skipping and result types

Add `skip` to a `fromPipeline` or `forEachPipeline` definition when the whole child
step may be omitted. Return `false` to proceed, a reason string to skip, or
`{ reason, value }` to skip with an output (no value publishes `undefined`), for
example `skip: ({ "resolve-shards": s }) => s.length === 0 ? { reason: "no shards", value: [] } : false`.
A skip does not call `items`, run children or apply `mapResult`, and required
dependents still run. Results are `T` and `readonly T[]`; a skip that can omit its
value widens them with `| undefined` (preserved if every branch supplies a value;
for fan-out, the whole array).

## Planning and execution controls

The parent plan holds one step for the child workflow ("opaque"): child steps are
not in `PipelinePlan.steps`, but `nestedPipeline` metadata names the child pipeline,
its declared step IDs, and whether it runs once or per item. Parent and child step
IDs are separate: a parent target never selects a same-named child step, and
`parent.child-step` selection is unsupported.

| Control           | Child behavior                                                                                |
| ----------------- | --------------------------------------------------------------------------------------------- |
| `dryRun`          | A child can enable it; a dry-running parent always forces it to `true`                        |
| `stepIds`         | Uses only the child-specific value supplied by `controls`                                     |
| `targets`         | Uses only the child-specific value supplied by `controls`; IDs must be declared child targets |
| `maxConcurrency`  | Uses only the value supplied by `controls`; defaults to `1` per child run                     |
| `continueOnError` | Uses only the value supplied by `controls`                                                    |

Domain options may share these names (`context.options.targets` versus
`controls.targets`). An invalid child plan fails the parent step before the child starts.

**Dry runs:** each child step follows its own policy: mark child writes
`dryRun: "skip"` or provide a preview handler, or set a policy on the wrapper to skip
or preview the whole child. A previewed child works on a copy of the inherited
checkpoint, so it cannot mark parent work done.

**Concurrency:** composition adds no checkpoints or crash recovery. Two independent
caps apply, and neither is inherited or clamped:

- `maxConcurrency` (`run(options, { maxConcurrency })`, `controls.maxConcurrency`, or
  the CLI's parent-only `--max-concurrency`) bounds steps in one DAG at run time.
- `forEachPipeline`'s `concurrency` bounds one fan-out step's children, fixed at
  authoring time (a bad value is rejected at creation or before any child starts).

They multiply: four parallel parent steps each fanning out with `concurrency: 8` can
run 32 children. Each wrapper holds one parent slot for its whole lifetime, and
there is no shared parent/child semaphore, which could deadlock.

## Failures and cancellation

A child must finish `"completed"` to give a successful output; `continueOnError` can
let independent child work finish, but a failed child still fails the parent step.
Child failures use `code: "TUBELESS_CHILD_FAILED"`, `phase: "execution"`,
`kind: "child"`, name the child pipeline and first failing step, and carry a
JSON-safe cause chain. With several children, failure outranks cancellation: the
parent is cancelled only when every unsuccessful child was cancelled.

Children receive the parent's exact `AbortSignal` and must pass it to their I/O.

`forEachPipeline` takes `onItemFailure`:

| Value              | Behaviour                                                                                                |
| ------------------ | -------------------------------------------------------------------------------------------------------- |
| `"fail"` (default) | Run every item, then fail the step. Successful siblings produce no partial output.                       |
| `"stop"`           | Start no further items after the first failure, let running items finish, then fail the step.            |
| `"collect"`        | Complete the step with one settled entry per item, in item order, so the next step decides what to keep. |

Under `"collect"` the output is `readonly ForEachSettledItem<T>[]` of
`{ key, index, ok: true, value }` or `{ key, index, ok: false, error }`, where
`error` is the bounded JSON-safe snapshot also used by `error.fanOut`. The step logs
one warning with the failure count and reports completed. Cancellation and scheduler
failures are never collected. See
[`fan-out-partial-results.ts`](../examples/fan-out-partial-results.ts).

For a single child with tolerated failure, use an ordinary step that calls the
child's `run()` and handles its report; do not forward the parent's raw hooks.

## Progress and hooks

Parent hooks observe only the parent step; child hooks become progress updates on
it. The interactive CLI nests child steps (and an item-key row per fan-out item)
under the parent. For fan-out, `total` is items times child steps;
`progress.itemNoun` and `progress.formatMessage` change labels only.

- Live fan-out shows up to 32 item groups (active and failed first, in input order)
  plus an omitted-count row; set `progress.detailLimit` to change it. The full tree
  is emitted at the end.
- Custom renderers read `details` ordered parent before child; `depth` 0 or absent
  is a direct child.
- Recorded trace snapshots hold at most 128 rows, 4096 characters per field and
  256 KiB; `detailCount` is the pre-truncation count.

## Structured fan-out failures

A failed or cancelled `forEachPipeline` step exposes `error.fanOut` on the run error
and step report (also in failure hooks, JSON output and traces):

- `failures`: the first 32 failed started items in input order, each with `index`,
  `key`, `keyTruncated`, `cancelled` and a JSON-safe `error` snapshot (no stacks,
  options or outputs). `failureCount` counts all failed started items;
  `omittedFailureCount` those beyond the limit. Keys are capped at 1024 UTF-16 code
  units, so recover truncated ones from the input index.
- `schedulerError` reports scheduler failures. Unstarted items (including those
  `"stop"` skipped) are not failures, and setup errors such as duplicate keys have
  no `fanOut`.

To rerun failures, select inputs by complete key, check `omittedFailureCount` and
unstarted work first (see the helper in
[`fan-out-progress.ts`](../examples/fan-out-progress.ts)). Reruns are ordinary new
runs; the caller owns retry policy and side-effect safety.
