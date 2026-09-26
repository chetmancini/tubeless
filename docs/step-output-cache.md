# Step output caching

Opt a deterministic ordinary step into caching with an implementation version.
Tubeless supplies the key, local store, and codec. The
[executable recipe](../examples/step-output-cache.ts) uses this configuration:

```ts
import { createSteps, definePipeline } from "tubeless";

const { step } = createSteps<{ text: string }>();
const count = step("count", {
  cache: { version: "count-v1" },
  run: (_inputs, context) => context.options.text.length,
});
const pipeline = definePipeline({
  id: "count",
  steps: [count],
  cache: { maxAge: "30 days" },
  finalize: count,
});

await pipeline.runOrThrow({ text: "hello" }); // execute and cache
await pipeline.runOrThrow({ text: "hello" }); // reuse, returning 5
await pipeline.runOrThrow({ text: "hello" }, { cache: "recompute" }); // refresh
```

Only opted-in steps use the cache. Configuring pipeline defaults does not make
other steps cacheable. Opting in promises that omitting the handler has no
required side effects.

## Defaults and expiration

The default directory is `<run cwd>/.cache/<pipeline-id>/<step-id>/`. It uses stable
IDs, not display names. Unusual characters are encoded and long segments are
bounded to avoid traversal and filesystem name collisions. Each entry has a
hashed filename. Override the root once with pipeline `cache.directory`; a
relative root is resolved against each run's `context.cwd`.

Set `cache.maxAge` on the pipeline, with an optional per-step `cache.maxAge`
override. Expiration belongs to cache policy and applies equally to all stores.
Omitting it retains entries indefinitely. Entries at or beyond the age limit
are misses. A zero age always recomputes. Reads do not delete expired files;
successful recomputation replaces them.

| Form                    | Examples                                        |
| ----------------------- | ----------------------------------------------- |
| Readable fixed duration | `"30 days"`, `"12 hours"`, `"500 milliseconds"` |
| Compact duration        | `"30d"`, `"12h"`, `"45m"`, `"500ms"`            |
| Numeric milliseconds    | `500`, `86_400_000`                             |

Units are milliseconds, seconds, minutes, hours, days, and weeks, with singular
and plural names. A day is exactly 24 hours. Fractions such as `"1.5 hours"` and `"1.001s"` are
accepted when they resolve to whole milliseconds. Decimal strings are scaled exactly;
sub-millisecond fractions are rejected rather than rounded. Months, years, absolute dates,
negative values, non-finite values, and fractional milliseconds are rejected
when the pipeline is defined. Durations must fit a nonnegative safe integer.

The timestamp comes from the run's `context.now`. Custom clocks and shared stores
must use the same time basis. With an age limit, a timestamp in the future is
also treated as a miss.

## Versions and keys

Set `cache.version` on a step, or use `cache: true` to inherit the pipeline's
`implementationVersion`. A version must be nonblank and at most 256 characters.
`cache: false` leaves a step uncached. Change the version when the handler,
output schema, key algorithm, or codec changes. Input hashing and graph
fingerprints cannot detect changed code or external data.

The default key hashes **dependency inputs and validated domain options**.
Pipeline ID, step ID, and implementation version supply additional namespaces.
Runtime controls, run IDs, timestamps, and other execution metadata are excluded.

Plain record keys are sorted. Values retain their types, including `undefined`,
`BigInt`, non-finite numbers, and `Date`. Arrays preserve their order and holes;
missing properties differ from published `undefined`. Cycles and shared references
are represented explicitly. Records are treated as unordered data. If property
insertion order affects your handler, supply a custom key.

Unsupported data, including functions, symbols, accessors, custom class instances,
`Map`, `Set`, and typed arrays, produces a key error. Supply a custom key rather
than letting a serializer silently discard data. The output codec supports more
types than the default key algorithm.

Override `key(inputs, context)` when only some inputs/options matter, when you
need fingerprints of external data, or when values need custom encoding:

```ts
cache: {
  version: "parse-v2",
  key: ({ source }, context) =>
    JSON.stringify([source.digest, context.options.locale]),
}
```

An explicit key must cover all relevant values. Return a nonblank string, or
`null` to bypass caching for the invocation. Pipeline configuration, step
configuration, and callback references are captured when `definePipeline`
compiles the graph; callbacks still own their closed-over application state.

## Run controls

| Policy      | Read | Execute handler | Write                     |
| ----------- | ---- | --------------- | ------------------------- |
| `use`       | Yes  | On miss         | On miss, after validation |
| `recompute` | No   | Yes             | Replace after validation  |
| `bypass`    | No   | Yes             | No                        |

The default is `use`. Set the run's second argument to `{ cache: "recompute" }`
or `{ cache: "bypass" }` to override all opted-in steps, including child pipelines.
This override takes precedence over child controls and step policies. Without a
run override, a step may supply `cache.policy`, either a policy string or a
callback receiving its typed inputs and execution context.

Pipeline commands expose `--cache use|recompute|bypass` automatically, and Studio
exposes the same execution control. Do not redeclare `cache` in command params or
add it to domain options. The control does not participate in the default key.
A bypass policy does not call the key callback, codec, or store; `null` keys also
bypass serialization and storage.

## Execution and failure rules

Selection and required-dependency checks precede cache access. A hit cannot
satisfy an unselected or blocked step, skip prerequisites, change targets,
or resume a partially executed handler.

| Boundary                  | Behavior                                                                    |
| ------------------------- | --------------------------------------------------------------------------- |
| Planning                  | No key, policy, codec, store, or handler calls; no cache directory created  |
| Dry run                   | Bypass all caching, including reads; normal dry-run policy still applies    |
| Policy skip               | Evaluate before cache access; publish the skip value without caching        |
| Test override             | Bypass cache, skip predicate, and handler; preserve override validation     |
| Remote and child wrappers | No cache option; ordinary steps inside children can opt in                  |
| Artifact loaders/savers   | Cache configuration is rejected by types and at runtime; I/O stays explicit |
| Declarative documents     | No cache authoring form in the first version                                |

On a miss, run the handler and encode its **raw result before output-schema
transformation**. Validate the raw result, then persist the encoded snapshot.
Publish the validated value only after a successful write. On a hit, decode a
fresh raw value and run `outputSchema` before publishing. This avoids feeding a
transforming schema its own output. `resultSchema` still runs normally. A cached
`undefined` is a hit; only an absent store entry means a miss.

Key, policy, read, encode, decode, and write failures fail the step. There is no
silent fallback to recomputation. Cache-operation failures use
`TUBELESS_STEP_FAILED`; the message identifies the operation and `cause` retains
the adapter error. Schema rejection uses `TUBELESS_STEP_OUTPUT_VALIDATION_FAILED`.
Corrupt entries fail until refreshed with `recompute`, removed, or invalidated
by a new version. Failed handlers and failed validation never write entries.
Existing entries survive failed recomputation.

Cache work occupies the normal concurrency slot and gets one attempt ID.
Cancellation checks surround cache operations and follow hit validation;
observed cancellation prevents further work and publication. Already committed
writes cannot be rolled back. Concurrent misses may both execute; there is no
distributed lock or exactly-once guarantee. Deterministic producers of the same
key must agree.

## Custom stores and codecs

Configure `cache.store` or `cache.codec` on the pipeline, with optional overrides
on individual steps. Defaults remain available for whichever setting you omit.
The local implementation is a lazily loaded utility using Node built-ins; core
has no runtime dependency on the Node entrypoint, run-history storage, or Studio.

`StepCacheStore` provides `get(key, { signal })` and
`set(key, entry, { signal })`. An entry is `{ value: Uint8Array, createdAtMs: number }`;
only `undefined` means a miss. Core checks the timestamp against the effective
age limit. Forward the signal to storage I/O. A store can keep timestamps and
blobs separately behind this interface.

Stores can optionally return an `ArtifactMetadata` receipt from `set`, and attach
one as `entry.artifact` from `get`. Include a physical `uri`, `byteSize`, and
`checksum` when available. These describe the stored bytes, including any envelope,
not just the encoded result. The file store supplies these automatically. Refresh
receipts on reads; do not persist a stale location supplied by another adapter.
Core supplies the stable artifact `id` and reserves `metadata.tubelessCache`;
other receipt fields are retained. Receipts use the same bounded JSON validation
as application artifacts. Invalid receipts fail the step, even without tracing;
a successful write cannot be undone if receipt validation then fails.

`StepCacheCodec` provides `encode(value)` and `decode(bytes)`. Store and codec
methods may be asynchronous. A codec must preserve the handler's value shape,
encode a detached snapshot, and decode a fresh value.

`tubeless/node` exports `createFileStepCache(directory)` and `v8StepCacheCodec`
for explicit configuration. The file store uses atomic replacement. An explicitly
created store resolves its directory at creation; the automatic store uses the
run's cwd. The V8 codec supports structured values including `undefined`, `Map`,
`Date`, and `BigInt`; functions fail serialization. Encoding also decodes the bytes
and checks strict deep equality with the original result before persistence. Lossy
conversions, such as class instances losing their prototypes (including inside
maps, sets, or records), fail with guidance to supply `cache.codec`. For domain
objects, provide a codec that reconstructs their type, or return plain data.
This round-trip check adds one decode and comparison on cache writes.
Treat entries as trusted local cache data, not portable archival files. Recompute after an incompatible runtime
or codec upgrade.

Remove a step's directory to reclaim its entries, or remove the dedicated cache
root to clear all cached results. Incrementing a version invalidates existing
entries without deleting them. Dedicated inspection/deletion commands remain
outside this first version.

## Observation

A hit keeps the ordinary completion status and its own attempt ID. Once a fresh
entry is found, terminal hooks, reports, and traces carry `outputSource: "cache"`,
including when decoding or validation subsequently fails or is cancelled. The
start event precedes lookup and does not yet claim a hit. CLI reporters and
Studio display `(cached)`, including in nested progress. Misses and expired
entries execute the handler normally.

Effective cache versions, normalized age limits, and policies appear in compiled
definition snapshots. Versions bind the combined definition ID; age limits and
policies participate in the structural fingerprint. Existing uncached definitions keep
their fingerprints, and readers accept prior recordings. Definition comparisons
show cache additions/removals, versions, age limits, and policies. Raw keys and encoded
values are not added to traces. Store locations are recorded when the adapter
supplies them, so trace access also exposes those paths.

Each successful cache write emits an ordinary `step.artifact` **write** event.
A hit emits **reuse** after decoding and output validation succeed. Misses,
expired entries, bypasses, and failed operations emit no cache artifact event
unless a new entry is successfully written. A completed write remains recorded
if cancellation or a later pipeline failure follows it.

Cache artifacts have an ID derived from the scoped cache key's SHA-256 hash and
`metadata.tubelessCache` containing `implementationVersion`, `createdAtMs`,
`ageMs` at the recorded operation, and `maxAgeMs` when configured. The ID identifies
the cache slot across runs; a replacement may have different bytes and checksum.
Stores without receipts still get this logical identity and age metadata, with
no invented location or physical size.

Existing NDJSON and SQLite history retain the records with their run, step, and
attempt. CLI history and Studio label them **Cached output**. Expand the Studio
record for location, creation time, age, and size; mixed artifact lists offer a
cache/application filter. This is historical evidence of an operation, not a live
cache inventory: recorded files may since have expired, changed, or been deleted.

Hits do not replay handler logs, progress, or application artifact records.
Caching a result that references a file does not cache or verify that file's
contents. See [artifact contracts](./artifacts.md) for application I/O lineage.
