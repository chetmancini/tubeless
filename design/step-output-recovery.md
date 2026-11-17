# Host-owned step output recovery

Proposed contract for [#287](https://github.com/chetmancini/tubeless/issues/287).
Slice 1 establishes the design and [compile-only probes](./step-output-recovery.probes.ts).
The proposed names below are not package exports. Runtime implementation starts
in slice 2; current host guides remain accurate until the later slices ship.

## Outcome and boundary

A host can save individual step outputs during a failed pipeline run and supply
those values to a later invocation. Supplying an output asserts that the step's
side effect already happened. Tubeless validates and publishes the supplied value
without invoking the handler. The host owns storage, encoding, retention,
execution ownership, and the decision that a saved value is still valid.

The recovery unit is a declared step of the configured pipeline invocation.
Child, remote, fan-out, and iteration wrappers are atomic at that boundary. An
unfinished wrapper runs again, even if some of its internal work completed.
Recovery settings never propagate automatically into children. This does not
change the agent journal, item checkpoints, or the opt-in step cache.

## Current implementation to reuse

Verified against `0564346`:

- [Test overrides](../src/testing/testing.ts) carry raw handler values into
  [the executor](../src/core/pipeline-execute.ts), validate them, and bypass the
  handler, skip predicate, cache, and dry-run handler for a selected step.
- [Override tests](../src/testing/overrides.test.ts) cover partial selection,
  schema transformations, cancellation, explicit `undefined`, failure policy,
  concurrent runs, and opaque wrappers.
- [The cache](../src/core/pipeline-cache.ts) encodes raw values before output
  validation and writes only after validation succeeds. Its
  [transformation test](../src/core/pipeline-cache.test.ts) deliberately mutates
  the raw object during validation.
- [Run state](../src/core/pipeline-run-state.ts) owns publication and terminal
  reports. [Lifecycle hooks](../src/core/lifecycle.ts) isolate callback failures
  and do not await them; they cannot acknowledge recovery persistence.
- [Definition identity](../src/core/pipeline-definition-identity.ts) separates
  graph structure from the explicit implementation version. Neither it nor a
  trace run ID identifies the host's business execution or input.

## Proposed run controls

Add two invocation-local fields to the controls accepted by `run` and
`runOrThrow`:

- `suppliedOutputs?: ReadonlyMap<TStepId, unknown>` supplies resolved raw values
  by declared step ID. `Map.has` distinguishes an absent entry from a saved
  `undefined`. Values decoded from storage intentionally remain `unknown` until
  the step's schema validates them. Without an output schema the host owns that
  type assertion, as it owns the original handler's implementation.
- `outputObserver?: PipelineStepOutputObserver<TStepId>` provides `encode` and
  `write` callbacks. Encoding receives an unknown raw value; writing receives
  detached bytes plus pipeline, step, run, optional attempt, definition identity,
  and origin metadata. Both callbacks can be asynchronous and receive the run's
  cancellation signal. The probes specify the proposed structural types.

The observer has no concrete store or codec default. A host can implement its
encoding with an existing codec, including `StepCacheCodec`, without sharing
cache entries, keys, retention, or cache policy. There is no package-owned
checkpoint file format or new CLI flag in this work.

Use a map rather than a second branded override helper: persisted values are
untrusted and addressed by stable IDs, while test fixtures benefit from typed
step/value pairs. Keep `overrideStep` and its testing contract intact. Supplying
a promise, an unknown step ID, or an entry for an unselected step is an error
before any handler or observer runs. Invalid recovery controls produce a failed
plan/run with `TUBELESS_RUN_OUTPUT_RECOVERY_INVALID`, phase `planning`, and kind
`validation`; `runOrThrow` throws the usual `PipelineExecutionError`.
Copy the map's entries at admission. The host decodes fresh values for each
invocation because schemas can mutate them; it must not share mutable restored
objects between concurrent runs or modify them while a run is active.

## Capture the replay representation before validation

Save the **raw handler result**, not the schema-transformed published output.
For example, a step returning `"21"` can publish the number `21`; supplying `21`
to its string-input output schema fails. A schema can also mutate the input
object, so retaining a raw reference until after validation is insufficient.

Use the same ordering already proven by the cache:

1. Obtain the raw value from the handler, cache decoder, or policy skip.
2. Await `outputObserver.encode(raw, context)` and copy its `Uint8Array` before
   calling the output schema. The encoder must produce a lossless detached
   representation and must not mutate the raw value. It prepares bytes without
   recording successful completion.
3. Validate/transform the original raw value exactly once with `outputSchema`.
4. Finish any normal cache write, then await `outputObserver.write(record, context)`.
5. Publish the validated value, emit the terminal step report, and unlock
   dependents. The step holds its concurrency slot through persistence.

Only `write` observes a successfully validated output. Failed validation never
calls it. A host that only needs observation can decode its own bytes there.
There is no cloneability requirement on ordinary runs without an observer.

The writer must resolve only after its chosen storage operation is acknowledged.
It can intentionally ignore records; that choice belongs to the host. Independent
steps can call the observer concurrently and settle in any order. A sink that
needs serialization must provide it. Stored byte buffers are owned by the sink;
they are never added to lifecycle events, logs, traces, or Studio payloads.

| Output path                                           | Capture behavior                                                                            |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Successful handler, including an opaque wrapper       | Encode raw result, validate, then write                                                     |
| Cache hit                                             | Encode decoded raw result before validation, then write with origin `cache`                 |
| Policy skip                                           | Encode the raw skip value, including `undefined`, validate, then write with origin `policy` |
| Structural skip, failed handler, or failed validation | No successful-output write                                                                  |
| Supplied output or test override                      | Validate normally; do not encode or write it again                                          |
| Dry run                                               | No observer calls, including for a custom preview handler                                   |
| Finalizer/result schema                               | Outside the step capture boundary                                                           |

Policy skips need no new attempt solely for capture; `attemptId` is optional on
their records. A capture record describes validated work and is not a promise
that the run or even its eventual terminal step report completed successfully.

## Failure and cancellation

Non-cancellation observer failure fails the step with a distinct
`TUBELESS_STEP_OUTPUT_OBSERVATION_FAILED` code, phase `execution`, and kind `step`.
Cooperative cancellation retains the existing cancellation classification.
Encoding or writing failure never silently falls back to an
unobserved completion. Required dependents remain blocked; `continueOnError`
and fail-fast retain their existing branch/drain behavior. Callback errors use
the existing structured error projection; host error messages must not contain
sensitive values. Core does not insert raw values or encoded bytes into errors.

Check cancellation before capture, after encoding/validation, and after the
write. An aborted or failed write can have committed remotely; only the host can
reconcile that uncertainty. If a write acknowledges and cancellation follows,
the saved record remains valid even if the step reports cancellation. Drain
in-flight observers before returning, just as active steps are drained today.

An external effect can happen before a process dies or before an output write
acknowledges. No callback ordering closes that window. Hosts must reconcile
uncertain effects or use business idempotency keys before retrying them. Recovery
does not promise exactly-once effects.

## Supply, selection, and precedence

Restore supplied raw values through the existing validated override path, with
`outputSource: "supplied"` distinct from `"override"` and `"cache"`. Preserve
that provenance on failed/cancelled validation too, and carry it through trace
schemas, projections, reporters, progress, and Studio. Never persist the value
through those metadata channels.

- Validate the domain options on every invocation, including a fully supplied run.
- Supplying an output never selects a step or prunes target prerequisites. An
  unfiltered run still runs every step. To omit upstream I/O behind a supplied
  intermediate, select that intermediate and its remaining consumers with exact
  `stepIds`; include each supplied step in the selection.
- A selected supplied step can satisfy its consumers even when its own required
  inputs are filtered out. Validate it when scheduled, rather than pre-publishing
  every supplied entry at run start. External cancellation and fail-fast still
  prevent unstarted steps from completing.
- With `continueOnError`, a supplied result can represent previously committed
  work beyond a failed prerequisite, matching the override path. Existing run
  errors remain errors; supplying values cannot turn a failed run into success.
- Supply bypasses skip predicates, handler/dry-run handlers, remote/child dispatch,
  and cache I/O. A dry run may reuse supplied values, but never writes observations.
- Reject combining nonempty test overrides with recovery controls until a separate
  composition contract exists. Existing tests without recovery controls keep
  their current behavior.

`plan` must account for supplied step IDs so it does not report their consumers
as structurally blocked. It remains synchronous: no encoding, storage, schemas,
or handlers run, and no supplied values appear in its result. A plan cannot
promise that a supplied value will validate. Keep ephemeral values and callbacks
out of persisted definition hashes and out of authored static child controls;
preserve the existing `snapshotRunControls` property order and identity fixtures.
Child authoring types and validation must reject these fields in v1 rather than
silently drop them. An application can separately call a child pipeline's `run`
with its own recovery controls.

## Host validity and recovery example

Before building `suppliedOutputs`, the host verifies a saved record belongs to
the same business execution, pipeline, step, compatible definition and explicit
implementation version, and relevant input. Input/codec identity, canonical
hashing, storage ownership, and the restore decision belong to the host. An
omitted `implementationVersion` means unknown compatibility; graph equality
alone cannot authorize automatic reuse. Code/schema, options, upstream outputs,
and external resource changes can invalidate a record. A saved object-storage
reference does not prove that its target still exists.

For the integration recipe, assign a host execution key and save raw values plus
the compatibility metadata above. Run a nine-step chain with an injected failure
at step 7. Create a fresh host/runtime instance, load and check the six saved
records, decode them, and run again with those six steps supplied. The first six
handlers must remain uncalled; steps 7–9 and finalization produce the same result
as an uninterrupted run. The example's file adapter stays application-owned and
uses a lossless codec; a separate case covers a supplied intermediate with its
upstream filtered out.

## Implementation slices

| Slice                      | Deliverable and acceptance                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 — Design and type probes | This note plus compile-only probes for transformed values, unknown decoded inputs, literal IDs/targets, required options, `undefined`, observer promises, and the absence of the feature from the current API. No runtime/public declaration change.                                                                                                                                                             |
| 2 — Observe outputs        | Implement the encoding/write boundary in the step executor, cache path, and policy-skip path. Prove encode-before-mutating-schema, write-before-dependent-start, validation failure, cache hit, persistence failure, cancellation races, independent concurrency, dry-run isolation, and wrapper scope. Add the error code, generate the API artifacts, and document the shipped observation contract.           |
| 3 — Supply outputs         | Add invocation-local map admission, truthful planning, validated publication, and `supplied` provenance across the metadata consumers. Prove unknown/unselected IDs and promises fail before I/O, input validation still runs, partial selection, cache/skip bypass, failure policy, `undefined`, cancellation, and child/static-control isolation. Keep override tests intact and regenerate the API artifacts. |
| 4 — Integrate and document | Add the fresh-instance nine-step recovery recipe/test, schema and codec round trips, compatibility rejection, and a simulated crash after an effect before acknowledgement. Update host guides, recipe index, project manifest, agent guidance/skill, and website; retain whole-attempt retry wording for host examples that still use it.                                                                       |

Run the focused probes/tests for each slice, then `make check`. Rebuild the
website when the shipped human-facing documentation changes. Public exports and
recommended usage change only in the corresponding runtime slices. The final
acceptance test is recovery through the public API across fresh instances, with
no leaked step values and no new runtime dependency.
