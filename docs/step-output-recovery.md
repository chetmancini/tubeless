# Recover saved step outputs

A host can record raw step results with `outputObserver`, then decode compatible
records into `suppliedOutputs` on a later invocation. The
[nine-step recipe](../examples/step-output-recovery.ts) fails at step 7, recreates
its pipeline and host store, and finishes with only steps 7–9 executing again.
The [file adapter](../examples/recovery/file-output-store.ts) belongs to the
example application; Tubeless owns neither its files nor its restore policy.

## Run the recipe

From this checkout, run:

```sh
bun -e '
import { tmpdir } from "node:os";
import { runRecoveryExample } from "./examples/step-output-recovery.ts";
const { directory, failed, resumed, resumedCalls } = await runRecoveryExample(tmpdir());
console.log({ directory, firstAttempt: failed.status, result: resumed.value, resumedCalls });
'
```

The result is `19`, from a seed of `10` and nine increments. The first attempt
reports `failed`; `resumedCalls` contains `step-7`, `step-8`, and `step-9`.
Each invocation of this demonstration creates a new private directory, so it
never removes or overwrites a previous execution's files. The project catalog
also registers the arithmetic pipeline; its ordinary CLI entry runs without
attaching this host store.

| Attempt    | Handler execution       | Saved outputs supplied | Newly recorded outputs |
| ---------- | ----------------------- | ---------------------- | ---------------------- |
| First      | Complete 1–6; fail at 7 | None                   | 1–6                    |
| Fresh host | Complete 7–9            | 1–6                    | 7–9                    |

The integration tests also repeat this flow in separate processes. They compare
the recovered result with an uninterrupted run and verify that the first six
handlers remain uncalled. Finalization runs normally after the remaining steps
complete.

## Decide whether a record is reusable

Use a stable business execution key, independent of Tubeless run IDs or host
retry attempt numbers. The adapter checks these fields before decoding each
saved value:

- Business execution ID and a hash of the normalized input.
- Pipeline ID, definition identity version, definition ID, structural fingerprint,
  and an explicit `implementationVersion`.
- Host file-format version, codec identity, and the expected step ID.

An absent implementation version fails store setup. Matching graph structure
alone cannot establish code or schema compatibility. Bump the implementation
version when the meaning of `performStep`, its schemas, or its dependencies
changes. The recipe's input hash covers its single `seed` field; adapt that
normalization to every input relevant to your own work. Bind live upstream data
to a snapshot or resource version when its contents affect reuse. Include tenant or owner
identity in the business execution key when executions cross those boundaries.

The loader inspects every saved output file and rejects incompatible records,
including removed step IDs, instead of silently rerunning their steps. A missing file means no recorded output; it does not prove that the
step's effect never happened. The host must also check whether references to
external data remain valid before reuse.

## Persist and restore

Copy both example files into your host and adapt the store to its persistence
contract. For a later invocation of the same arithmetic execution:

```ts
import { RecoveryPipeline, recoveryInputIdentity } from "./step-output-recovery.js";
import { openRecoveryStore } from "./recovery/file-output-store.js";

const input = { seed: 10 };
const store = await openRecoveryStore(directory, RecoveryPipeline, {
  executionId: "example-job-42",
  inputIdentity: recoveryInputIdentity(input),
});
const run = await RecoveryPipeline.run(input, {
  suppliedOutputs: await store.load(),
  outputObserver: store.observer,
});
```

The observer saves encoded **schema inputs**. Each step returns integer text,
which its output schema publishes as a number; supplying the number would fail
that same schema. The optional V8 codec also preserves `undefined`, Dates, Maps,
and BigInts. The adapter binds its codec identity to the runtime's V8 and Bun
versions and rejects a mismatch. It does not define a portable interchange
format between runtimes.

Each step has its own file. `writeJson` atomically replaces that complete file
before the observer acknowledges it, so independent steps do not race over a
shared manifest. The adapter rejects writes from another pipeline definition.
Local write/rename acknowledgement covers the process-restart example; it does
not promise power-loss durability or distributed execution locking. Give one
host exclusive ownership of the execution directory and secure existing
storage directories appropriately.

Each load decodes fresh objects because schemas can mutate them. A successful
restore still validates domain options and step outputs. Supplied steps are not
encoded or written again. Plans, step hooks, traces, and Studio carry provenance,
not saved domain values; protect the output files as application data. Dry runs
call neither the recipe's business callbacks nor the output observer. Use
`plan({ dryRun: true })` to preview the skipped graph without requesting a final
result.

## Skip upstream work behind a saved intermediate

Supply only entries included in the exact selection. To restore step 6 and run
steps 7–9 without executing steps 1–5:

```ts
const restored = await store.load();
if (!restored.has("step-6")) throw new Error("No saved step-6 output");
const run = await RecoveryPipeline.run(input, {
  stepIds: ["step-6", "step-7", "step-8", "step-9"],
  suppliedOutputs: new Map<"step-6", unknown>([["step-6", restored.get("step-6")]]),
  outputObserver: store.observer,
});
```

Supplying an output never selects its step or removes target prerequisites.
An unfiltered run still selects every step. Child, remote, fan-out, and iteration
wrappers remain atomic at this invocation boundary; an incomplete wrapper runs
again. Read the [observation and supply contract](./step-output-observation.md)
for failure, cancellation, selection, and validation rules.

## Reconcile effects that have no saved output

The crash test terminates a host process immediately after step 7 commits an
external effect and before its output observer writes the record. The next
host sees only six saved outputs. Step 7 must consult the external service using
the same business idempotency key before deciding whether to execute the effect.
The fixture models that service with a create-once receipt file: two handler
attempts yield one committed effect, then steps 8–9 finish.

Without such reconciliation or idempotency, retrying the handler can duplicate
the effect. Saving outputs does not provide exactly-once effects. A lost write
acknowledgement can also leave a valid record behind, even if Tubeless reports
failure or cancellation. Resolve uncertainty at the host's business boundary.

The Airflow, Temporal, Inngest, Dagster, and Step Functions examples retain their
whole-attempt retry behavior. Add observation, compatibility checks, loading, and
supply explicitly in a host adapter to use this recovery pattern; correlation
IDs and trace storage do not enable it. This recipe adds no general CLI
`--resume` flag and does not alter agent journals or item checkpoints.
