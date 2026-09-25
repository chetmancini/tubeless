# Artifact loaders, savers, and lineage

Use `context.recordArtifact` at an explicit I/O boundary to identify what a step
read, wrote, or reused. The step keeps its ordinary typed result, dependencies,
and dry-run policy. Filesystem, database, object-store, and SDK adapters stay in
application code; Tubeless adds no runtime dependencies.

## Record operations inside ordinary steps

```ts
const release = step("release", {
  dependsOn: [validateEdition],
  dryRun: "skip",
  run: async ({ "validate-edition": edition }, context) => {
    const result = await publishOrReuseEdition(edition, context.signal);
    context.recordArtifact({
      operation: result.reused ? "reuse" : "write",
      artifact: {
        id: edition.id,
        uri: result.manifestUri,
        version: result.semanticKey,
      },
    });
    return result;
  },
});
```

`validateEdition` and `publishOrReuseEdition` above belong to the application.
Record `write` after persistence succeeds, `read` after reading succeeds, and
`reuse` after verifying an existing artifact. A reuse record does not claim a new
write. `ArtifactRecord` names this operation-plus-metadata contract.

Call `recordArtifact` more than once for multiple inputs, outputs, or committed
batches. Records already emitted remain in traces if a later batch fails or the
step is cancelled. Keep checkpoint advancement after successful persistence;
recording is observation, not a commit or checkpoint mechanism. A failure before
reporting an operation cannot produce its artifact record.

Each call validates and snapshots metadata synchronously, even without tracing.
Later mutations cannot change recorded metadata. Calls after the handler settles
are ignored. Reporting does not change the step's output or validate domain values.
Use ordinary output schemas where needed.

## Convenience loaders and savers

`loadArtifact` and `saveArtifact` from `createSteps` produce ordinary steps for a
single read or unconditional write. Both adapters return an `ArtifactResult<T>`:
`{ value, artifact }`. Dependents receive the inferred `value` type; only `artifact`
is recorded. This lets a saver return a typed receipt, paths, validation results,
or another domain value without placing it in trace metadata.

```ts
const { loadArtifact, saveArtifact } = createSteps();
const load = loadArtifact("load", {
  load: async (_inputs, context) => ({
    value: await readRows(context.signal),
    artifact: { id: "source-rows", version: "revision-3" },
  }),
});
const save = saveArtifact("save", {
  dependsOn: [load],
  save: async ({ load: rows }, context) => {
    const receipt = await writeRows(rows, context.signal);
    return {
      value: receipt,
      artifact: { id: "normalized-rows", uri: receipt.uri },
    };
  },
});
```

`readRows` and `writeRows` are application functions. Reusable adapter contracts
are `ArtifactLoader<TInput, TValue, TOptions>` and
`ArtifactSaver<TInput, TValue, TOptions>`; both receive the ordinary step context.
Wrap an adapter in `load` or `save` to map options or dependency outputs to its input.
The helpers record one operation after the adapter succeeds. Use an ordinary
step for conditional writes, reuse, mixed I/O, or incremental persistence instead
of recording the same operation both inside an adapter and through a helper.

Both helpers support required dependencies, optional dependencies, failure gates,
names, and descriptions. Forward `context.signal` to adapters that support
cancellation. Tubeless does not roll back I/O or stop an adapter that ignores its signal.

See the executable [artifact lineage recipe](../examples/artifact-lineage.ts)
for cancellable file reads, atomic JSON writes, typed receipts, and previews. The
[example project](../examples/project/tubeless.project.ts) registers it for CLI
and Studio:

```sh
bunx tubeless run --project examples/project/tubeless.project.ts --trace run.ndjson artifact-lineage -- --source rows.txt --destination build/rows.json
bunx tubeless history --trace run.ndjson
bunx tubeless ui --trace run.ndjson
```

## Dry runs

Ordinary steps still need `dryRun: "skip"` or a side-effect-free preview handler
for writes. `recordArtifact` observes operations; it never prevents I/O.

Savers default to `dryRun: "skip"`. Their normal `save` handler never runs during
a pipeline dry run. A custom `dryRun` handler returns `{ value, artifact }` to
preview the destination and provide a typed preview receipt to dependents.

Loaders run normally during dry runs. A loader that downloads files, populates a
cache, or writes sidecars is side-effecting: preserve `dryRun: "skip"` or supply
a side-effect-free preview. A loader preview also returns `{ value, artifact }`.
Plans call neither adapters nor preview handlers. Filtered or structurally skipped
steps emit no artifact records.

During a dry run, all records from a custom `dryRun` handler are previews. Normal
handlers can record actual reads or verified reuse; any write record is marked
as a preview. This flag does not make an unsafe handler safe. Never perform the
write merely because its record will be marked as a preview.

## Collections and content identity

For a multi-file edition or index, record its existing manifest or collection
location instead of copying every file and report into trace metadata. Record
separate inputs when their identity matters. A semantic key can be `version`;
`checksum` must describe the bytes of the artifact actually identified by `uri`.
For example, don't attach a database checksum to its manifest's URI.

Keep validation, temporary files, atomic promotion, and publication policy in
the application. Record a promoted artifact after promotion succeeds. Its record
does not imply later validation or publication succeeded; inspect the owning
step/run status and application manifest too.

## Metadata and persistence

Supply at least one of `id` or `uri`. Use `id` for application-owned logical
identity, `uri` for a physical location, and `version` or `checksum` for the
content observed at that location. Tubeless does not resolve URIs, compute
checksums, or assume two artifacts are equal merely because their locations match.

| Field           | Meaning                                                                |
| --------------- | ---------------------------------------------------------------------- |
| `id`            | Application-owned logical identifier                                   |
| `uri`           | Location or application-owned URI                                      |
| `mediaType`     | Media type, such as `application/json`                                 |
| `checksum`      | Application-computed digest; include its algorithm, such as `sha256:…` |
| `version`       | Content version or storage revision                                    |
| `byteSize`      | Nonnegative safe integer, when known                                   |
| `schemaVersion` | Application schema version                                             |
| `metadata`      | Application JSON object with additional descriptive fields             |

Metadata must be plain JSON: finite numbers, strings, booleans, null, dense
arrays, and plain objects. Omit unavailable fields; `undefined`, functions,
symbols, class instances, getters, and `toJSON` methods are rejected. Metadata is
copied and validated even when tracing is disabled. Invalid metadata fails the
step; a saver may already have written its artifact before returning invalid metadata.

Each metadata record is limited to 16 KiB of UTF-8 JSON, 256 visited values, and
a nesting depth of 8 (the metadata record is depth 0). Named string fields have a
4,096-code-unit limit. String/key encoding is also budgeted during traversal.
Oversized records fail instead of silently truncating identity. Put large manifests
in an artifact and record their location. Traces and Studio do not redact values:
never record credentials, signed URLs, secrets, or sensitive application data.

Accepted `recordArtifact` calls emit a version 2 `step.artifact` trace event. Its payload
contains `operation` (`read`, `write`, or `reuse`), `preview`, and `artifact`. The event also
carries the owning pipeline, run, step, execution attempt, and timestamp, plus
parent/correlation identifiers when present. Loaded values are not recorded.
A helper records nothing if its adapter fails before returning. Direct reports
already made survive a later handler, step, or finalizer failure. This is observation, not a transaction receipt.

SQLite and NDJSON retain these events. History JSON exposes them under each
step's `artifacts`; `history <run-id>` and Studio show reads, writes, reuse, and previews
on that step. Expand an artifact in Studio to inspect its metadata. Join logical
IDs and content versions across recorded runs when tracing provenance; there is
no automatic cross-run artifact catalog or cache. Saved version 2 recordings
without artifact events remain readable.
