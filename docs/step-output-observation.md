# Observe step outputs

Pass `outputObserver` in a pipeline's run controls to capture raw step results
through your own encoder and writer. Tubeless awaits the write before publishing
the validated value and starting dependent steps. The
[executable recipe](../examples/step-output-observation.ts) captures text while
its output schema publishes a character count.

```ts
import { v8StepCacheCodec } from "tubeless/node";

const run = await pipeline.run(options, {
  outputObserver: {
    encode: v8StepCacheCodec.encode,
    async write(record, { signal }) {
      await outputStore.save(record, { signal });
    },
  },
});
```

`pipeline` and `outputStore` are application-owned. The Node codec is optional;
other runtimes supply their own lossless encoder. There is no default output
store, encoding, retention policy, or CLI flag. Capturing values does not yet let
production runs supply them back: that boundary is a later implementation slice
of [#287](https://github.com/chetmancini/tubeless/issues/287).

## Encode first, write after validation

The observer has two callbacks:

- `encode(value, { signal })` receives the raw handler result as `unknown`,
  before `outputSchema` transforms or mutates it. Return a lossless `Uint8Array`
  snapshot without mutating the value. Core copies the bytes before validation.
  Encoding may run even when validation later rejects the result; do not record
  successful completion in this callback.
- `write(record, { signal })` receives the detached encoded bytes after output
  validation and any normal cache write succeed. Resolve after your persistence
  acknowledges the write. The record includes `pipelineId`, `stepId`, `runId`,
  optional `attemptId`, `definitionIdentity`, `origin`, and `encodedValue`.

A string-input output schema can publish a number. The saved bytes represent the
string, so a host can later decode the same schema input. Saving the published
number would lose that property. Encoders must preserve supported values such as
`undefined` and reject unsupported values rather than silently change their shape.
The optional V8 codec rejects lossy round trips; see [cache codecs](./step-output-cache.md#custom-stores-and-codecs).

The observer belongs to this invocation and its methods are captured when the
run starts. Independent steps can encode and write concurrently, bounded by the
run's `maxConcurrency`; a step holds its slot through persistence. A sink that
needs serial writes must serialize them itself. Treat callback values and metadata
as read-only; ownership of each encoded byte buffer transfers to the writer.

## Which outputs are captured

| Output                                  | Behavior                                                                      |
| --------------------------------------- | ----------------------------------------------------------------------------- |
| Successful handler                      | Encode its raw result, then write with origin `handler`                       |
| Cache hit                               | Encode the decoded raw value, then write with origin `cache`                  |
| Policy skip                             | Encode the skip value, including `undefined`, then write with origin `policy` |
| Structural skip or failed handler       | No observer call                                                              |
| Failed output validation or cache write | Encoding may have happened; no output write                                   |
| Dry run                                 | No observer calls, including for preview handlers and policy skips            |
| Finalizer and result schema             | Outside this step boundary                                                    |

Policy skips without output schemas need no execution attempt; their records
omit `attemptId`. Child pipelines, remote steps, fan-out, and iteration are
captured as whole wrapper outputs. The observer is never inherited into child
runs. Authored `PipelineChildRunControls` reject `outputObserver`; explicitly invoke a
pipeline's `run` separately to configure its own observer.

`plan({ outputObserver })` validates the callback shape but calls neither method.
Observers do not select steps, change definition identity, or place values in
plans, step hooks, traces, reports, or Studio. Protect output storage as application
data. Host callbacks and their error messages must apply your redaction policy.
The final pipeline result remains available through the usual result hooks.

## Failures and uncertain writes

Invalid observer controls fail planning with
`TUBELESS_RUN_OUTPUT_RECOVERY_INVALID`. Encoder/writer failure or invalid encoded
bytes fail the step with `TUBELESS_STEP_OUTPUT_OBSERVATION_FAILED`, phase
`execution`, kind `step`. Required dependents remain blocked. Fail-fast stops new
dispatch and drains active work; `continueOnError` allows independent branches.
`runOrThrow` throws `PipelineExecutionError` for an unsuccessful run. Nonempty
test overrides cannot be combined with an observer; ordinary test runs can use
one to exercise their host persistence.

Both callbacks receive the run signal. Cancellation checks surround capture and
writing, and the run waits for started callbacks to settle. A write may commit
before cancellation or a lost acknowledgement: its saved record may remain valid
even when the step reports cancellation. The host must reconcile uncertain writes.

Output capture does not make external effects exactly once. A process can die
after an effect but before recording its result. Use business idempotency keys or
reconcile the effect before retrying. A graph fingerprint does not establish code
compatibility; hosts deciding future reuse also need explicit implementation,
business execution, input, and codec identity. Missing implementation versions
mean compatibility is unknown. The [design note](https://github.com/chetmancini/tubeless/blob/main/design/step-output-recovery.md)
tracks the remaining supply and recovery work.
