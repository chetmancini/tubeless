# Host-owned execution journal

Pass `executionJournal` in the third argument to `pipeline.run` or
`pipeline.runOrThrow` to recover acknowledged work in a fresh process. The host
supplies a `PipelineExecutionJournal` from `tubeless`. Adapt the
[host example](../examples/host-embedding.ts); correlation IDs, history recording
and `context.checkpoint` alone do not resume pipeline steps.

For trusted Worker-root launches in self-hosted Cloudflare, set
`recoverInterruptedRuns: true` to use the built-in journal and recover across
Worker attempts. See [Worker recovery](./deploy-cloudflare.md#recover-an-interrupted-worker-execution).

The prototype is `chetmancini/tubeless-cloud`'s `docs/interactive-execution.md`,
`patches/tubeless@0.4.0.patch`, `src/worker/run-journal.ts` and
`src/worker/runner-interactive.ts`, inspected on 2026-11-15. The 0.4.0 port is
uncommitted work based on Cloud commit `653de7e`; it is evidence, not an upstream
API. Existing upstream contracts are [definition identity](./studio.md#definition-history-and-comparison),
[child composition](./child-pipeline-composition.md) and
[native agent durability](./agents.md#durable-execution).

## Ownership and identity

An optional caller capability lets Tubeless recover one logical execution in a
fresh process. The host owns durable records, codecs, limits, retention, exclusive
ownership, leases and fencing. It also owns human-input requests, response
authorization, suspension, waiting status and wakeups. Core owns the ordering of
acknowledgements and execution. It adds no storage adapter or Cloud dependency.
Runs without the capability keep their existing behavior.

The host binds the capability to a stable logical execution key. Tubeless derives
collision-free, versioned paths from pipeline and step IDs and composition
occurrences: a single child, a fan-out item key, or a one-based iteration index.
Include every ancestor and distinguish occurrence kinds; never join unescaped
strings or use scheduling order, timestamps or attempt IDs. Duplicate fan-out
keys are rejected before dispatch. Reusing a pipeline in separate parent steps
must produce distinct paths.

Unlike the Cloud prototype, each invocation keeps a fresh
`runId`, including children, as documented today. Recovery keys are separate from
run/attempt IDs; `parentRunId` links the current invocation tree. The logical
identity must be available to host input callbacks so Cloud can stop deriving
request keys from stable runtime run IDs. A new intentional execution needs a new
host key. `correlationId` alone grants no recovery authority.

## Compatibility before dispatch

Before a pipeline dispatches steps, `bind(path, binding)` must atomically save or
compare a lossless snapshot. Tubeless binds original input, journal protocol
version, compiled definition identity, effective selection/run controls and cwd
before schema validation can mutate inputs, then binds validated options
separately. Fan-out also binds its ordered items and keys before dispatch. Every
journaled pipeline requires a nonblank `implementationVersion`, including children;
native agents keep their existing inherited-version checks. Version handlers,
schemas, mappers, predicates and finalizers when their semantics change. Structural
fingerprints alone cannot establish code compatibility.

An absent run-wide cache override stays distinct from explicit `cache: "use"`:
omission preserves each step's cache policy, while an explicit override replaces it.

The host atomically records a first binding or rejects a different binding for
the same path. Check child bindings when entering each child, even if the parent
was already admitted. Check dependency inputs again when beginning a step.
Comparisons use lossless value semantics, including absent values; lossy JSON
stringification is insufficient. A host may reject unsupported values. Bindings
and outputs must be owned snapshots so later application mutation cannot change
saved recovery state. Source revision pinning remains the host's responsibility.

## Acknowledgement protocol

Implement these operations on the caller capability:

- `key`: stable host execution key, included in each logical path.
- `bind(path, binding)`: store or compare compatibility data; reject a difference.
- `begin(path, inputs, boundary)`: return `{ status: "new" }`,
  `{ status: "incomplete" }`, or `{ status: "completed", value }`. Record both
  inputs and the `"effect" | "orchestration"` boundary kind and reject changes.
- `complete(path, value)`: acknowledge an existing intent's validated output.
- `agentStore` when hosting agents: supply `acquire(key)` returning native
  `read`, `write`, and `close` byte-lease operations. Existing
  `AgentCheckpointStore` implementations are structurally compatible.

Callbacks receive `context.executionJournalPath`, a frozen logical path for the
current boundary. Use its lossless encoding with the host execution key for input
request deduplication. The path starts with journal protocol `v1`, execution key
and pipeline identity; children add their owning step, occurrence kind and child
pipeline. Hosts should treat the full path as opaque rather than parsing IDs.
Keep journal protocol/version compatibility with saved records when upgrading.

For a selected ordinary step, after replay-safe skip evaluation:

1. Await `begin` with its stable path, dependency inputs and boundary kind.
   A new intent is durable before permission to invoke the handler is returned.
2. If completion is already recorded, restore the saved validated output and
   bypass the handler and cache. Preserve successful `undefined` distinctly from
   no completion. Output-schema transformations already ran before storage and
   must not run again on their transformed output.
3. Otherwise execute and validate normally, then await `complete` with the
   validated output. Publish completion and release dependents only after this
   acknowledgement. A cache hit still needs this acknowledgement.

`begin` atomically distinguishes a new intent, an existing incomplete intent and
a completed value. `complete` requires a matching intent, commits atomically and
is idempotent for an identical value; conflicting completions fail. The host may
retry transport with the same operation identity and payload. Core never retries
a handler to repair an acknowledgement failure. It never treats a rejected,
malformed or undecodable journal response as a cache miss.

| Saved state on recreation | Ordinary effect boundary         | Supported orchestration boundary                     |
| ------------------------- | -------------------------------- | ---------------------------------------------------- |
| No intent                 | Acknowledge intent, then execute | Acknowledge intent, then enter                       |
| Intent without completion | Stop: outcome unknown            | Re-enter its recovery mechanism                      |
| Acknowledged completion   | Restore its value                | Restore its value, except native agent handoff below |

An effect interrupted before its completion acknowledgement has an unknown
outcome and cannot be automatically repeated. This includes a thrown handler,
output-validation/encoding failure after an effect, and a lost completion reply.
On recreation, a durably saved completion can settle a lost reply; an incomplete
ordinary intent requires host/operator reconciliation. No exactly-once effect
guarantee or generic retry-safe flag is introduced.

## Supported replay boundaries

Only built-in child composition (`fromPipeline`, keyed `forEachPipeline`,
`iteratePipeline`), `waitForInput` and native agent checkpoint handoff may re-enter
an incomplete boundary. A child wrapper rebuilds orchestration while completed
descendant steps restore their outputs. Fan-out items, keys and mapped options
must reproduce the same ordered work; iteration reconstructs state through saved
child results and replay-safe transitions. Stable item keys do not authorize
changed inputs or collection membership.

An input step may call its reader again. The host must deduplicate the request
using the logical identity and return a saved response or resume waiting. A reader
must not perform unjournaled nonrepeatable work. Core neither infers suspension
from thrown text nor adds a waiting lifecycle.

Options/schema callbacks, skip predicates, child item/option/result mappings,
iteration initializers/transitions, finalizers and hooks must tolerate replay.
Skips and finalization are recomputed; finalization is outside step completion.
Put nonrepeatable effects in ordinary journaled steps. Hooks/traces/transcripts
are observation, not acknowledgements; restored outputs do not replay historical
logs, progress or artifact writes. A completed wrapper need not recreate child
history. Arbitrary nested calls inside an ordinary handler, remote execution and
user-created orchestration do not gain resumability from this capability.
Journaled child dispatch rejects externally implemented pipeline objects; use a
compiled Tubeless pipeline so definition binding and step recovery can be checked.

## Native agents

Keep native recovery as the sole owner of agent decisions, tools, budgets and
conversation. Prefer an inherited agent journal, then explicit agent durability,
then the host's checkpoint-store handoff keyed by logical path. The host supplies
the existing lossless byte-lease operations; core needs no agent runtime import.
Missing handoff support fails before agent work rather than silently running it
without recovery.

The host handoff derives a bounded, opaque SHA-256 checkpoint key from the full
logical path, including long host and fan-out keys. Explicit agent durability keys
remain unchanged.

In `src/agent/invocation.ts`, suppress the outer step journal in the agent's
execution scope, including ordinary pipeline tools and delegated agents. The
native agent boundary always enters native checkpoint recovery rather than
short-circuiting its completed result through the outer journal. This preserves
completed session restoration and the replayed transcript end event. Preserve
environment/input/version checks, inherited journal ownership, lease cleanup and
opt-in transcript capture. Existing native tool replay rules still apply: unsafe
interrupted calls become interruption outcomes; explicitly safe calls may repeat.
The outer journal adds no broader guarantee for those effects.

## Failure, cancellation and dry runs

Journal errors are execution failures, preserving the host error's code and cause
through `run` diagnostics and `runOrThrow`. They stop further admission and drain
in-flight work, including under `continueOnError` or fan-out collection; a host
failure cannot become a collected business outcome. No completion acknowledgement
means no successful step publication. Preserve failure evidence when cancellation
and a journal failure race. A signal abort is cancellation, not proof of rollback;
already acknowledged completions survive it. Core does not revoke leases or
declare an interrupted effect safe to repeat.

Use `PipelineError.sourceCode` to distinguish host codes and journal diagnostics:
`TUBELESS_JOURNAL_OUTCOME_UNKNOWN`,
`TUBELESS_JOURNAL_IMPLEMENTATION_VERSION_REQUIRED`,
`TUBELESS_JOURNAL_INVALID_RESPONSE`,
`TUBELESS_JOURNAL_AGENT_STORE_REQUIRED`, and
`TUBELESS_JOURNAL_UNSUPPORTED_CHILD`. Other host failures without a code use
`TUBELESS_EXECUTION_JOURNAL_FAILED`. Original exceptions remain in the cause chain;
these errors never fall back to executing the handler.

An active journal rejects nonempty `suppliedOutputs` before journal adapter
operations or step dispatch, with `TUBELESS_JOURNAL_SUPPLIED_OUTPUTS_UNSUPPORTED`.
Choose one recovery authority so external supplies cannot bypass journal checks
or native agent recovery. Empty supplies are allowed. An `outputObserver` may
capture raw outputs alongside a journal: its write completes before journal
completion, and journal-restored values do not invoke the observer again.

Planning, invalid plans, test overrides and dry-run execution make no journal or
agent-store calls, including identity allocation or compatibility binding. Remove
the capability from preview contexts, including child-only dry runs. Existing
`context.checkpoint` propagation and dry-run copies remain separate. That
completed-item store, step caches and test overrides are not execution recovery.
Dry runs can use supplied outputs without activating the journal or observer.

## Verification and Cloud migration

Tests must recreate both executor and adapter against retained records, covering
acknowledged completion, incomplete intent, lost replies, binding/input changes,
lossless restored values, mutation isolation, journal failures, abort races, dry
runs/overrides, nested pipelines, keyed fan-out, iteration and delegated agents.
Check native session/transcript replay, inherited journals, version rejection and
ordinary runs without the capability. Include non-idempotent schema transforms
to prove restoration does not transform outputs twice.

Upstream validation includes `make check`, generated public API reports and the
website build. After the upstream release, adapt Cloud, remove only superseded journal hunks, and pass Cloud's
`make check`, including human-input recreation and retained source snapshots.
Cloud's existing snapshots keep their bundled runtime; do not assume they acquire
new exports or the new logical identity contract. Remove Bun patch registration
only after every remaining hunk has an upstream replacement.
