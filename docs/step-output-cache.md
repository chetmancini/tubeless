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

Only opted-in steps use the cache; pipeline-level settings never make other
steps cacheable. Opting in promises that skipping the handler has no required
side effects.

## Defaults and expiration

Entries live in `<run cwd>/.cache/<pipeline-id>/<step-id>/`, keyed by stable IDs,
not display names. Set pipeline `cache.directory` to move the root (a relative
root resolves against `context.cwd`).

`cache.maxAge` on the pipeline, with an optional per-step override, expires
entries. Omitted, entries are kept indefinitely. Entries at or beyond the limit
are misses, a zero age always recomputes, and recomputation replaces expired
files. Accepted forms: `"30 days"`, `"12 hours"`, `"30d"`, `"45m"`, `"500ms"`, or
numeric milliseconds, with fractions allowed when they resolve to whole
milliseconds. Months, years, dates, negative, and non-finite values are rejected
at definition time. Ages use `context.now`; custom clocks and shared stores must
share a time basis.

## Versions and keys

Set `cache.version` on a step, or `cache: true` to inherit the pipeline's
`implementationVersion`. `cache: false` leaves a step uncached. **Change the
version whenever the handler, output schema, key algorithm, or codec changes**:
input hashing cannot detect changed code or external data.

The default key hashes **dependency inputs and validated domain options**, plus
pipeline ID, step ID, and version. Run controls, run IDs, and timestamps are
excluded. Records are treated as unordered (sorted keys); arrays keep order.
`undefined`, `BigInt`, non-finite numbers, and `Date` are supported. Functions,
symbols, accessors, class instances, `Map`, `Set`, and typed arrays throw a key
error: supply a custom key instead.

Override `key(inputs, context)` when only some inputs matter, external data needs
a fingerprint, or property insertion order affects the handler:

```ts
cache: {
  version: "parse-v2",
  key: ({ source }, context) =>
    JSON.stringify([source.digest, context.options.locale]),
}
```

An explicit key must cover every relevant value. Return a nonblank string, or
`null` to bypass caching for that invocation.

## Run controls

| Policy      | Read | Execute handler | Write                     |
| ----------- | ---- | --------------- | ------------------------- |
| `use`       | Yes  | On miss         | On miss, after validation |
| `recompute` | No   | Yes             | Replace after validation  |
| `bypass`    | No   | Yes             | No                        |

The default is `use`. A run's `{ cache: "recompute" | "bypass" }` overrides every
opted-in step, including child pipelines and step `cache.policy`. Commands expose
`--cache use|recompute|bypass` and Studio the same control; do not redeclare
`cache` in command params or domain options. A step's `cache.policy` may be a
string or a callback receiving its inputs and context.

## Execution and failure rules

Selection and required-dependency checks come first: a hit cannot satisfy an
unselected or blocked step.

| Boundary                  | Behavior                                                    |
| ------------------------- | ----------------------------------------------------------- |
| Planning                  | No key, codec, store, or handler calls                      |
| Dry run                   | Bypasses all caching, including reads                       |
| Policy skip               | Evaluated before cache access; the skip value is not cached |
| Test override             | Bypasses cache, skip predicate, and handler                 |
| Remote and child wrappers | No cache option; ordinary steps inside children can opt in  |
| Artifact loaders/savers   | Cache configuration rejected by types and at runtime        |
| Declarative documents     | No cache authoring form                                     |

- On a miss, the **raw handler result** is encoded and persisted before
  `outputSchema` transforms it; the validated value is published after a
  successful write. On a hit, the decoded raw value goes through `outputSchema`
  again. A cached `undefined` is a hit.
- Key, policy, read, encode, decode, and write failures fail the step, with no
  silent fallback to recomputation (`TUBELESS_STEP_FAILED`, adapter error on
  `cause`). Corrupt entries fail until recomputed, removed, or invalidated by a
  new version. Failed handlers or validation never write entries, and existing
  entries survive a failed recompute.
- Concurrent misses may both execute; there is no lock or exactly-once guarantee,
  so producers of the same key must agree.

## Custom stores and codecs

Configure `cache.store` or `cache.codec` on the pipeline, with optional per-step
overrides.

- `StepCacheStore`: `get(key, { signal })` and `set(key, entry, { signal })`,
  where an entry is `{ value: Uint8Array, createdAtMs: number }`. Only
  `undefined` means a miss. Forward the signal to storage I/O. A store may
  return an `ArtifactMetadata` receipt (`uri`, `byteSize`, `checksum`) from
  `set` and attach it as `entry.artifact` on `get`; refresh it on reads rather
  than persisting a stale location.
- `StepCacheCodec`: `encode(value)` and `decode(bytes)` (sync or async). It must
  preserve the value's shape, encode a detached snapshot, and decode a fresh
  value.

`tubeless/node` exports `createFileStepCache(directory)` (atomic replacement) and
`v8StepCacheCodec`, the default. The V8 codec handles `undefined`, `Map`, `Date`,
and `BigInt`, and rejects functions. It decodes what it encodes and fails on lossy
round trips, such as class instances losing prototypes: return plain data or
supply a codec that reconstructs the type. Treat entries as trusted local cache
data, not archival files, and recompute after incompatible runtime or codec
upgrades.

To clear entries, remove a step's directory or the cache root; incrementing a
version invalidates them without deleting.

## Observation

A hit keeps the ordinary completion status with its own attempt ID, and its
terminal hooks, reports, and traces carry `outputSource: "cache"`. CLI reporters
and Studio show `(cached)`. Hits do not replay handler logs, progress, or
application artifact records, and caching a result that references a file does
not cache or verify that file.

Each successful write records a `step.artifact` **write** event and each hit a
**reuse** event, labeled **Cached output** in history and Studio. These record
past operations, not live cache inventory. Raw keys and encoded values are never
traced. See [artifact contracts](./artifacts.md) for application I/O lineage.
