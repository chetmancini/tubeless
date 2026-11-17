# Artifact loaders, savers, and lineage

Use `context.recordArtifact` at an explicit I/O boundary to identify what a step
read, wrote, or reused. The step keeps its ordinary typed result, dependencies,
and dry-run policy; I/O adapters stay in application code.

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

`validateEdition` and `publishOrReuseEdition` belong to the application. Record
`write` after persistence succeeds, `read` after reading succeeds, and `reuse`
after verifying an existing artifact. Call it once per input, output, or
committed batch; emitted records survive a later failure or cancellation.

- Recording is observation, not a commit or checkpoint: advance checkpoints only
  after successful persistence.
- Metadata is validated and snapshotted synchronously, even without tracing.
  Calls after the handler settles are ignored.
- Recording never changes the step's output; use output schemas to validate
  domain values.

## Convenience loaders and savers

`loadArtifact` and `saveArtifact` from `createSteps` produce ordinary steps for a
single read or unconditional write. Each adapter returns `{ value, artifact }`:
dependents receive the typed `value`, and only `artifact` is recorded.

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

Reusable adapters implement `ArtifactLoader` and `ArtifactSaver`. The helpers
record one operation after the adapter succeeds. For conditional writes, reuse,
mixed I/O, or incremental persistence, use an ordinary step instead, and do not
record the same operation in both an adapter and a helper. Forward
`context.signal`; Tubeless does not roll back I/O or stop an adapter that
ignores it.

See the [artifact lineage recipe](../examples/artifact-lineage.ts):

```sh
bunx tubeless run --project examples/project/tubeless.project.ts --trace run.ndjson artifact-lineage -- --source rows.txt --destination build/rows.json
bunx tubeless history --trace run.ndjson
bunx tubeless ui --trace run.ndjson
```

## Dry runs

`recordArtifact` observes operations; it never prevents I/O. Ordinary steps still
need `dryRun: "skip"` or a side-effect-free preview for writes.

- Savers default to `dryRun: "skip"`. A custom `dryRun` returns
  `{ value, artifact }` to give dependents a typed preview receipt.
- Loaders run normally during dry runs. A loader that downloads files or writes
  sidecars is side-effecting: keep `dryRun: "skip"` or supply a preview.
- Plans never call adapters or previews; filtered or skipped steps emit no
  records.
- Records from a custom `dryRun` handler are previews, and write records in
  normal handlers are marked as previews during a dry run. The flag does not make
  an unsafe handler safe: never write just because the record is a preview.

## Collections and content identity

For a multi-file edition or index, record its manifest or collection location
rather than every file. `version` is a semantic key; `checksum` must describe the
bytes at `uri` (do not attach a database checksum to a manifest URI). Keep
validation, temp files, atomic promotion, and publication policy in the
application, and record a promoted artifact only after promotion succeeds; a
record does not imply later validation or publication succeeded.

## Metadata and persistence

Supply at least one of `id` or `uri`. Tubeless does not resolve URIs, compute
checksums, or treat two artifacts as equal because their locations match.

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

Metadata must be plain JSON (finite numbers, strings, booleans, null, dense
arrays, plain objects). Omit unavailable fields; `undefined`, functions, symbols,
class instances, getters, and `toJSON` are rejected, and invalid metadata fails
the step (a saver may already have written its artifact). Each record is limited
to 16 KiB of JSON, 256 values, and depth 8, with 4,096 code units per named
string; oversized records fail rather than truncate. Put large manifests in an
artifact and record its location.

**Traces and Studio do not redact values: never record credentials, signed URLs,
secrets, or sensitive data.**

Accepted records emit a `step.artifact` trace event with `operation`, `preview`,
and `artifact`, tied to the pipeline, run, step, and attempt. Loaded values are
not recorded. SQLite and NDJSON retain these events; `tubeless history <run-id>`
and Studio show them on each step, and history JSON exposes them under
`artifacts`. There is no cross-run artifact catalog: join logical IDs and
versions across runs yourself. [Step output caching](./step-output-cache.md)
records its entries as write/reuse artifacts shown as **Cached output**.

## Structured check reports

The optional [Vitest diagnostic adapter](structured-diagnostics.md) normalizes a
runner JSON artifact into a bounded report. Store its body in an artifact and use
ordinary `recordArtifact` metadata for lineage. Reports are untrusted
observations and cannot establish successful check receipts.
