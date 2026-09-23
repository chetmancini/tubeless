# Tubeless on Dagster

Run a Tubeless pipeline as a Dagster asset using Dagster Pipes. Dagster owns
asset scheduling, dependencies, and retries; Tubeless owns the typed steps,
progress, and execution trace inside the asset's subprocess.

```text
Dagster asset → PipesSubprocessClient → Node.js → Tubeless pipeline
                     ← logs, traces, and materialization metadata ←
```

The example normalizes rows, validates the dataset, and writes a JSON artifact.
After successful execution, it reports a materialization with the row count,
artifact path, content data version, Tubeless run ID, and trace path. Operators
can follow progress in Dagster and inspect individual pipeline steps in Tubeless
Studio. See Dagster's [TypeScript Pipes integration](https://docs.dagster.io/integrations/libraries/typescript).

## The example

| File                                                             | Responsibility                                                            |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------- |
| [`pipeline.ts`](../examples/dagster/pipeline.ts)                 | Normalize, validate, and publish through public Tubeless imports          |
| [`hosted.ts`](../examples/dagster/hosted.ts)                     | Bridge Pipes context, logs, traces, and materialization reporting         |
| [`worker.ts`](../examples/dagster/worker.ts)                     | Open and close Pipes, forward process termination to Tubeless             |
| [`definitions.py`](../examples/dagster/definitions.py)           | Define the asset, launch Node, save the trace, and yield materializations |
| [`test_definitions.py`](../examples/dagster/test_definitions.py) | Exercise the real Python host and Node worker                             |

The pipeline has no Dagster imports and also runs from the local project.
The bridge uses `@dagster-io/dagster-pipes` 0.1.0, installed as a repository
development dependency. Applications adopting this bridge install the SDK in
their own project. Tubeless itself retains a dependency-free runtime.
The Python example is tested with Dagster 1.13.24.

## Run locally

Use Node.js 22.6 or later, Bun, Python 3.12, and
[uv](https://docs.astral.sh/uv/getting-started/installation/). From the repository root:

```sh
bun ci
bun run build
bunx tsc -p examples/dagster/tsconfig.build.json
uv venv --python 3.12 .context/dagster-venv
uv pip install --python .context/dagster-venv/bin/python \
  'dagster==1.13.24' 'dagster-webserver==1.13.24'
.context/dagster-venv/bin/dagster dev -f examples/dagster/definitions.py
```

The compiler writes JavaScript to `.context/dagster/`. Open the local Dagster
UI at `http://localhost:3000`, select `normalized_rows`, and materialize it.
The execution host must have Node, the compiled worker, and its installed
dependencies available. Keep the dev server's process running while you inspect
the asset and run history.

The default input produces `{"rows":["alpha","beta"]}` in
`.context/dagster-artifacts/<dagster-run-id>/rows.json`. Open the materialization's
metadata to find the artifact, row count, data version, and Tubeless trace.
These paths refer to the execution host's filesystem. For distributed workers,
publish artifacts and traces to shared storage and report accessible locations.

To change the input, open the asset's launch configuration and supply:

```yaml
ops:
  normalized_rows:
    config:
      lines: [" Alpha ", "Beta", "ALPHA"]
```

Use the local Tubeless command below for previews. The Dagster asset always
publishes: Pipes requires asset outputs even when an asset declares its output
optional. The host disables implicit materializations and requires exactly one
explicit materialization from the worker, so a missing report fails the attempt.
The worker rejects `dryRun: true` instead of accidentally publishing a preview.

## Logs, traces, and asset identity

The bridge forwards pipeline logs and progress counts through the Pipes logger.
It sends raw Tubeless trace events as Pipes custom messages. After a successful
subprocess exit, the Python host writes these events to `trace.ndjson`.
The sample does not retain a separate trace file for failed or
killed subprocesses; their Pipes logs remain in Dagster. For large or long-running
jobs, stream traces to your own durable exporter rather than accumulating custom
messages in the host.

Copy the recorded trace path into these commands to inspect a finished run:

```sh
bun run tubeless -- history --trace .context/dagster-artifacts/<dagster-run-id>/trace.ndjson
bun run tubeless -- ui --trace .context/dagster-artifacts/<dagster-run-id>/trace.ndjson
```

Replace `<dagster-run-id>` with the actual ID before running the commands.
Trace files contain recorded logs and event payloads; apply your application's
redaction policy at the exporter.

Each Tubeless attempt has a fresh `runId`. Its correlation ID combines the
Dagster run ID and asset key and stays stable across step retries within that
run. The optional `parentRunId` in the bridge is reserved for a known Tubeless
execution; a Dagster run ID is a separate identity.

The materialization's `dataVersion` hashes the normalized row array, so repeated
attempts with the same rows have the same version. It describes logical content,
not the file's formatting or the implementation release. Tubeless's
`implementationVersion` separately identifies the example's handler release.
This recipe handles one selected asset per invocation.

## Retries and cancellation

Dagster retries the asset at most twice after its initial attempt. An exception
from `runOrThrow` causes a nonzero worker exit, which fails the asset attempt.
Validation failure prevents publication and materialization. Successful
publication is reported only after the pipeline finishes.

A retry runs the whole Tubeless pipeline again. The example replaces the same
run-specific JSON dataset; a new Dagster run gets a separate directory. This
does not make arbitrary side effects exactly-once. If publication succeeds and
reporting fails, Dagster may retry. Use idempotent writes or business-level keys
when adapting the pipeline to external services. Split independently retryable
datasets into separate Dagster assets when you need recovery at those boundaries.

The default `PipesSubprocessClient` forwards host termination to its subprocess.
The worker turns `SIGTERM` and `SIGINT` into an abort signal and closes Pipes
when execution settles. Normalization cooperates through `context.sleep`.
Cancellation does not roll back an artifact already written, and blocking I/O
can delay it; Dagster may forcibly stop a subprocess that exceeds its termination
timeout. See [Dagster Pipes](https://docs.dagster.io/integrations/external-pipelines/using-dagster-pipes)
for other execution environments.

## Run the pipeline directly

Use the same pipeline through the example project for local iteration:

```sh
bun run tubeless -- plan --project examples/project/tubeless.project.ts dagster-dataset
bun run tubeless -- run --project examples/project/tubeless.project.ts dagster-dataset -- \
  --lines " Alpha " --lines "Beta" --output-path ./rows.json --dry-run
```

Local execution writes no Dagster metadata. Relative output paths resolve from
the project execution directory. The Pipes worker requires a real Pipes context
and rejects standalone launches without one.

## Verification

`make check` compiles the TypeScript examples and tests the real Pipes SDK in
subprocesses without a Dagster service. Tests cover metadata and content versions,
retry identity, raw traces, malformed inputs, validation failure, dry runs, and
cooperative termination.

After the local setup and worker compilation, run the Python integration tests:

```sh
.context/dagster-venv/bin/python -m unittest discover -s examples/dagster -p 'test_*.py'
```

These launch the compiled Node worker from the real Dagster execution engine.
They verify a successful materialization and trace, and a failed dataset that
exhausts Dagster's retry policy without materializing an asset.
The Python tests are optional and are not part of the dependency-free package's
`make check` environment.
