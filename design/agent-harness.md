# Structured agent harness: stage 1 contract

Status: API design and compile-time probes. The harness is not implemented or
exported. The first release will execute in process; crash-safe resume follows
in a later release.

The [prototype declarations](./agent-harness.prototype.ts) and
[type probes](./agent-harness.probes.ts) fix the proposed boundaries before
runtime implementation. They are checked by `bun run typecheck` and `make check`.
They have no runtime implementation and must not be executed. `design/` is
excluded from the npm artifact; the packed-artifact check enforces that boundary.

## API decisions

An agent is an ordinary compiled pipeline with one outer step and target,
`agent`. `defineAgent` preserves its literal ID, raw input schema, transformed
result type, and definition metadata. It works with existing `fromPipeline`,
`defineProject`, and `definePipelineCommand`. Schema metadata remains necessary
for automatic CLI flags. There is no separate agent project or command registry.

The proposed `tubeless/agent` entrypoint owns `defineAgent`, `defineTool`,
`pipelineTool`, `ToolError`, and their contracts. It depends on core, utilities,
and trace emission. Core stays independent of the agent entrypoint, model SDKs,
storage, CLI, and Studio. Model prompting and provider request/response mapping
remain application-owned.

`createSteps` gains one generic constructor, `iteratePipeline`. The prototype
declares only this addition; probes use the real public factory for existing
constructors. The constructor takes a child pipeline, `initialState`,
`mapOptions`, `transition`, and a required finite `maxIterations`. It supports
required dependencies, a static set of child controls, and whole-step dry-run
skip. Other composition conveniences can follow a demonstrated need.

Each iteration runs the child and then calls `transition(result, state, context)`.
The transition returns either `{ kind: "next", state }` or
`{ kind: "finish", result }`. The finish value is the iteration step's output;
it may legitimately be `undefined`. A default pipeline finalizer or explicit
`finalize: iterationStep` retains its existing meaning.

## Agent decisions and capabilities

The `decide(state, context)` callback returns untrusted data. The harness always
validates it, even if a provider SDK advertises a typed response. Applications
can use `satisfies AgentDecision<typeof tools, RawResult>` for typed fixtures and
hand-authored decisions. Type-checking fixtures does not validate model output.

| Decision   | Required payload | Meaning                                             |
| ---------- | ---------------- | --------------------------------------------------- |
| `continue` | Nonempty `calls` | Admit a batch of independent registered calls.      |
| `finish`   | `result`         | Validate the raw result and finish this invocation. |

A decision cannot contain both calls and a final result. An empty continue
batch, unknown tool, duplicate call ID, invalid argument, extra control field,
or invalid final result fails the invocation. V1 does not automatically ask the
model to repair malformed decisions. A result such as `null` is accepted only
when the result schema accepts it; absence is distinct from a published value.

Use one `tools` registry. Each entry is created through one of these boundaries:

| Constructor                     | Input validation                                                              | Execution                      | Result                                                           |
| ------------------------------- | ----------------------------------------------------------------------------- | ------------------------------ | ---------------------------------------------------------------- |
| `defineTool`                    | Required `inputSchema`                                                        | `run(validatedInput, context)` | Required `outputSchema` validates/transforms the handler return. |
| `pipelineTool(child, metadata)` | Reuse the child's `optionsSchema`                                             | Ordinary child pipeline        | The child's exact final result.                                  |
| `pipelineTool(child, mapping)`  | Explicit `inputSchema`, then `mapOptions` and the child's schema when present | Ordinary child pipeline        | The child's exact final result.                                  |

The explicit mapping form handles schema-less pipelines and differently shaped
model arguments. It maps validated arguments to the child's raw accepted input.
No result mapper is added initially; a child finalizer or ordinary wrapper
pipeline already owns that operation. Registering an agent uses the same
`pipelineTool` constructor as any other child pipeline.

Tools require a description and model-facing JSON Schema for their raw input.
Use the input schema's Standard JSON Schema converter with target
`draft-2020-12`; an explicit `inputJsonSchema` is the fallback. The final-result
descriptor likewise uses the result schema's **input** conversion or
`resultJsonSchema`. A missing or invalid descriptor fails definition validation.
Explicit descriptors are application assertions of agreement with validators;
the runtime validator remains authoritative. No schema library enters core.

The decision context exposes capability descriptions/JSON Schemas and the final
result JSON Schema, alongside normal step services, `turn`, and `stateVersion`.
It does not hand the model executable handlers or authority to add capabilities.

## Validation and one turn of execution

1. Check cancellation and the per-invocation turn bound. Reserve one shared
   decision admission and invoke `decide` with the current state snapshot.
2. Validate the decision envelope. For finish, validate/transform the result
   once and publish it through the outer pipeline's finalizer. Stop here.
3. For continue, validate all names, IDs, argument schemas, child input mappings,
   child input schemas, and child plans before starting any call in the batch.
   Retain the validated values; execution must not apply transformations again.
4. Atomically reserve the complete batch against shared call budgets, then
   dispatch under the active-execution limits. Calls have no implicit sibling
   data dependencies. A dependent action goes in the next turn or an authored
   child pipeline.
5. Wait for all admitted execution to settle. Build outcomes in decision order.
   If any fatal failure occurred, preserve observations in lifecycle records and
   fail without applying the reducer or starting another turn.
6. Call `reduce(state, outcomes)` once, validate ownership of its result, and
   publish the next state version. Repeat with a fresh child turn run.

The result schema runs exactly once. The agent implementation must choose one
validation owner rather than validate finish data and then accidentally pass
its transformed output through the same schema again. The same rule applies
to tool arguments/results and prevalidated child options. Internal validated
execution entrypoints must accept only a privately prepared value, never an
unchecked public bypass flag.

## State and errors

`initialState` runs once for each invocation, after input validation. Its return
type determines the reducer's state contract. Decisions and reducers receive
deeply read-only state. Agent state consists of finite primitive values, arrays,
and plain records; optional/undefined fields are allowed in process. Functions,
class instances, cycles, and resources such as clients or file handles belong
in application closures, not agent state. Runtime initialization and each
reducer commit create and freeze owned snapshots; sharing mutable backing data
between runs is forbidden. Generic iteration does not add a persistence codec.

State version starts at zero and advances once for each accepted batch, even
when the reducer is omitted and the state is unchanged. An omitted reducer
does not accumulate observations automatically. Agents that learn from tool
outcomes supply a reducer. The decision's `turn` is one-based; finish performs
no further state reduction. These counters are run data, not mutable fields on
a reusable agent definition.

Handlers can deliberately throw `ToolError(code, message)` for a domain failure
the model may respond to. Only an actual handler-originated `ToolError` becomes
an `{ ok: false, error }` observation. Matching an arbitrary error's string code
is insufficient. A child pipeline qualifies only when its failures consist
entirely of these expected handler errors, without cancellation or other
failures; combine bounded error information deterministically.

Invalid schemas, failed output validation, reducer failures, unknown exceptions,
and cancellation are fatal. Expected failures retain failed child lifecycle
records even when the agent continues. Existing `fromPipeline` and
`forEachPipeline` continue to throw on failed children; the agent dispatcher
uses a focused internal full-report invocation boundary to classify outcomes.

Keep the core run statuses `completed`, `failed`, and `cancelled`. Agent failures
use existing step-error wrapping with stable source codes such as
`TUBELESS_AGENT_INVALID_DECISION`, `TUBELESS_AGENT_INVALID_STATE`, and
`TUBELESS_AGENT_LIMIT_REACHED`. Generic iteration uses
`TUBELESS_ITERATION_LIMIT_REACHED`. Limits include the bound, consumed count, and
scope in diagnostics. `runOrThrow` throws on all unsuccessful runs. Budget
exhaustion is never a successful final answer or a recoverable tool error.

## Limits, cancellation, and dry-run

Limits are definition configuration in v1, separate from domain input. There
are no new agent-specific positional run arguments or overloads. Applications
can construct a definition with different limits. Existing outer pipeline
`maxConcurrency` controls its DAG; it does not override agent call concurrency.

| Limit            | Default | Accounting                                                         |
| ---------------- | ------- | ------------------------------------------------------------------ |
| `maxTurns`       | 20      | Decision invocations in one agent, including a finishing decision. |
| `maxCalls`       | 100     | Admitted tool/child calls across this agent and its descendants.   |
| `maxDecisions`   | 100     | Admitted decision callbacks across this agent and its descendants. |
| `maxDepth`       | 4       | Delegation edges below this agent; zero permits leaf tools only.   |
| `maxConcurrency` | 1       | Active decision callbacks and leaf tool handlers in the subtree.   |

All limits are safe integers. Turn/decision/concurrency limits must be positive;
call/depth limits may be zero. A child may impose a tighter local subtree bound;
all ancestor bounds continue to apply. Charge an entire batch on admission.
Calls cancelled before dispatch still consume their admission; there are no
refund races. Reject an oversized batch before any member starts. A finish on
the last allowed turn succeeds. A continue on that last turn fails before tools
start because no later decision could consume their results.

`maxDecisions` counts harness callbacks, not hidden HTTP requests or money. V1
adds no automatic retries. Provider SDK retries and internal requests within a
handler remain the application's responsibility. Any future harness retries
must consume the relevant admission budget.

Allocate the shared execution scope on the root invocation, never on the
definition. Core will carry one private opaque scope slot through runtime
normalization and child contexts; the agent layer owns its counters and limiter.
Core does not interpret agent policy. This slot must survive ordinary pipelines
between parent and child agents. It is not a public extension registry, a
global run-ID map, domain input, or serialized model context. Add this transport
only when implementing tree-wide admission in stage 4.

An active parent wrapper waiting on children holds no shared execution permit.
A decision releases its permit before dispatching calls. Descendant leaf work
acquires applicable ancestor/local permits in a consistent order. Tests with
concurrency one must prove nested calls cannot deadlock.

Cancellation stops new admissions and dispatch, propagates the same signal to
active work, and drains all active descendants before return. Fatal fail-fast
stops dispatch and drains without automatically cancelling siblings, preserving
existing pipeline behavior. In-process handlers must cooperate with signals;
the harness cannot forcibly terminate an uncooperative promise.

`plan()` performs no model request, state initialization, argument validation,
mapping, or tool execution. An agent dry run skips live decision callbacks by
default. The optional `dryRun` callback replaces `decide` with a preview source.
Handler tools default to dry-run skip and may supply a typed preview handler.
Child pipelines keep their existing dry-run policies and always inherit the
parent's dry-run flag. A parent child pipeline with unmarked side effects still
needs correct dry-run authoring. A skipped required output produces no invented
observation or answer and fails required finalization through existing behavior.

## Identity, plans, and saved recordings

Definitions and executions have different identities. Definition snapshots
describe iteration structure, registered capabilities and child identities,
validation boundaries, dry-run behavior, limits, and an author/build-supplied
`implementationVersion`. Prompts, validators, mappings, and handler semantics
are covered by that implementation version, not inferred by hashing closures.
JSON Schema descriptors can be recorded as bounded metadata with canonical
hashes; bounded/truncated snapshots cannot pretend to be complete definitions.

| Identity                      | Scope                                                               |
| ----------------------------- | ------------------------------------------------------------------- |
| Pipeline ID and definition ID | Stable definition, independent of model choices and batch size.     |
| Run ID                        | One actual root, turn, tool pipeline, or child pipeline execution.  |
| Turn index and state version  | One agent invocation.                                               |
| Logical call ID               | Agent run + turn index + decision call ID.                          |
| Attempt ID                    | One execution attempt; distinct from the logical call ID.           |
| Provider call ID              | Optional provider correlation; never the global execution identity. |

Future retries keep logical call identity and create a new attempt. Provider
IDs may repeat across turns, but decision IDs must be unique within a turn.
Use structured parent/run/turn/call fields for joins; readable paths are display
values. Retain the parent wrapper step/attempt relationship so history can
distinguish two calls to the same child in one turn.

Static plans expose an iteration region, child template, bound, and capability
inventory. They do not invent future steps or accept future call IDs as static
`--step` targets. Runtime traces describe actual expansions and outcomes.
Bounded progress rows are presentation; they are not the complete history.

The proposed compatibility change is explicit: keep identity v1 hashing and
its old test vectors unchanged; add identity v2 for extended iteration/agent
semantics and parents that contain them. Ordinary unchanged definitions retain
their v1 identity. Introduce trace v3 for new writes with typed iteration/call
relations and decision/limit summaries; readers continue accepting trace v2.
The run report stays at its existing version unless its shape changes. Do not
silently widen the v2 wire enum for nested modes or reinterpret old hashes.

Stage 2 must update plan metadata, definition compilation, schemas/codecs,
decoders, and storage projections together before emitting the new records.
Stages 3–4 fill agent-specific records as execution lands; stage 5 completes
presentation. Old records may lack relationships and remain inspectable with
unknown metadata. State, prompts, and tool bodies are not traced by default.

Trace export remains best-effort. Recovery later needs an independently
acknowledged journal with explicit codecs, persisted decisions/outcomes/state,
restored budgets, ownership, and side-effect reconciliation. Stage 1 does not
declare a storage API or promise serialization of arbitrary schema outputs.

## Evidence and next implementation boundary

The probes check immediate finish, two tools followed by finish, parent pipeline
composition, pipeline/subagent delegation, and expected-error recovery. They
also reject invalid tool names, mismatched inputs/outputs, mixed or empty
decisions, invalid state reduction, missing child mappings, mistyped project
lookups, and dynamic IDs used as static targets. Iteration probes preserve
transformed dependency outputs, raw parent inputs, schema-backed CLI inference,
schema-less explicit CLI parameters, and a precise `undefined` finish result.

This is compile-time evidence. It does not prove scheduling, isolation,
cancellation, recovery, validation counts, or successful execution of a declared
prototype. The first runtime PR is stage 2: implement bounded iteration using
ordinary child execution, with deterministic tests for transitions, limits,
run isolation, selection, cancellation, dry-run, and saved-record compatibility.
Stages 3–4 then convert the agent probes into executable public-package examples.
