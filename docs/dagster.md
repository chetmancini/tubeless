# Tubeless on Dagster

Run a Tubeless pipeline as a Dagster asset using Dagster Pipes. Dagster owns
asset scheduling, dependencies, and retries; Tubeless owns the typed steps,
progress, and trace inside the asset's subprocess.

```text
Dagster asset → PipesSubprocessClient → Node.js → Tubeless pipeline
                     ← logs, traces, and materialization metadata ←
```

The example normalizes rows, validates the dataset, writes a JSON artifact, and
reports a materialization with row count, artifact path, content data version,
Tubeless run ID, and trace path. See Dagster's
[TypeScript Pipes integration](https://docs.dagster.io/integrations/libraries/typescript).

## The example

| File                                                             | Responsibility                                                        |
| ---------------------------------------------------------------- | --------------------------------------------------------------------- |
| [`pipeline.ts`](../examples/dagster/pipeline.ts)                 | The pipeline, with no Dagster imports                                 |
| [`hosted.ts`](../examples/dagster/hosted.ts)                     | Bridge Pipes context, logs, traces, and materialization reporting     |
| [`worker.ts`](../examples/dagster/worker.ts)                     | Open and close Pipes, forward process termination to Tubeless         |
| [`definitions.py`](../examples/dagster/definitions.py)           | Define the asset, launch Node, save the trace, yield materializations |
| [`test_definitions.py`](../examples/dagster/test_definitions.py) | Exercise the real Python host and Node worker                         |

The bridge uses `@dagster-io/dagster-pipes` 0.1.0 (install it in your own
project); the Python side is tested with Dagster 1.13.24.

## Setup

Use Node.js 22.18 or later, Bun, Python 3.12, and
[uv](https://docs.astral.sh/uv/getting-started/installation/). From the
repository root:

```sh
bun ci
bun run build
bunx tsc -p examples/dagster/tsconfig.build.json
uv venv --python 3.12 .context/dagster-venv
uv pip install --python .context/dagster-venv/bin/python \
  'dagster==1.13.24' 'dagster-webserver==1.13.24'
.context/dagster-venv/bin/dagster dev -f examples/dagster/definitions.py
```

Open `http://localhost:3000`, select `normalized_rows`, and materialize it. The
execution host needs Node, the compiled worker, and its dependencies. The
default input writes `{"rows":["alpha","beta"]}` to
`.context/dagster-artifacts/<dagster-run-id>/rows.json`; paths are on the
execution host, so with distributed workers publish artifacts and traces to
shared storage and report those locations. To change the input, set the launch
configuration:

```yaml
ops:
  normalized_rows:
    config:
      lines: [" Alpha ", "Beta", "ALPHA"]
```

Inspect a finished run's trace (replace `<dagster-run-id>`):

```sh
bun run tubeless -- history --trace .context/dagster-artifacts/<dagster-run-id>/trace.ndjson
bun run tubeless -- ui --trace .context/dagster-artifacts/<dagster-run-id>/trace.ndjson
```

## How Tubeless maps to Dagster

- **Logs and traces:** progress and logs go through the Pipes logger; raw trace
  events travel as Pipes custom messages, and the Python host writes
  `trace.ndjson` after a successful exit. Failed or killed subprocesses keep
  only their Pipes logs. For large or long jobs, stream traces to a durable
  exporter instead of accumulating messages in the host, and redact them.
- **Identity:** each attempt has a fresh `runId`. Correlation combines the
  Dagster run ID and asset key and is stable across step retries.
  `parentRunId` is for a known Tubeless execution only.
- **Data version:** `dataVersion` hashes the normalized rows, so repeated
  attempts with the same rows match. It does not reflect file formatting or the
  handler release (`implementationVersion` does).
- **One asset per invocation:** the recipe handles one selected asset at a time.

## Retries, cancellation, and gotchas

- **Always publishes:** Pipes requires asset outputs, so the asset cannot be a
  dry run. The host disables implicit materializations and requires exactly one
  explicit materialization, so a missing report fails the attempt. The worker
  rejects `dryRun: true`. Preview with the local project command below.
- **Retries:** Dagster retries at most twice after the first attempt. An
  exception from `runOrThrow` exits nonzero and fails the attempt; validation
  failure prevents publication. A retry reruns the whole pipeline and replaces
  that run's JSON file, but is not exactly-once for other side effects (a
  publication can succeed while reporting fails). Use idempotent writes, and
  split independently recoverable datasets into separate assets.
- **Cancellation:** `PipesSubprocessClient` forwards host termination; the
  worker turns `SIGTERM`/`SIGINT` into an abort signal. Steps must cooperate
  (for example via `context.sleep`). Already-written artifacts are not rolled
  back, and Dagster may force-kill a subprocess past its termination timeout
  ([Dagster Pipes](https://docs.dagster.io/integrations/external-pipelines/using-dagster-pipes)).

```sh
bun run tubeless -- plan --project examples/project/tubeless.project.ts dagster-dataset
bun run tubeless -- run --project examples/project/tubeless.project.ts dagster-dataset -- \
  --lines " Alpha " --lines "Beta" --output-path ./rows.json --dry-run
```

The local command writes no Dagster metadata; the Pipes worker rejects
standalone launches.

`make check` tests the real Pipes SDK in subprocesses without a Dagster service.
The optional Python integration tests run the compiled worker under the real
Dagster engine:

```sh
.context/dagster-venv/bin/python -m unittest discover -s examples/dagster -p 'test_*.py'
```

## Host-owned output recovery

This adapter retains the whole-attempt retry behavior described above. To reuse
individual step outputs across attempts, add host-owned persistence, compatibility
checks, loading, and `suppliedOutputs` explicitly. Adapt the
[fresh-host recovery recipe](./step-output-recovery.md) and reconcile uncertain
side effects with business idempotency keys before retrying.
