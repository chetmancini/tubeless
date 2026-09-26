# In-process agents

`tubeless/agent` builds an ordinary pipeline around a bounded decision loop.
Each turn calls your `decide` callback, validates its decision, executes a batch
of registered tools, and reduces their outcomes into the next state. A finish
decision validates and returns the agent's result.

The [scripted agent recipe](../examples/agent.ts) runs without model credentials:

```sh
make run FILE=examples/agent.ts ARGS='--question "hello tubeless"'
make run FILE=examples/agent.ts ARGS='--question "missing word"'
make run FILE=examples/agent.ts ARGS='--dry-run --question "preview"'
make plan FILE=examples/agent.ts
```

It creates a variable number of calls, preserves their decision order, recovers
from a deliberate domain error, and transforms the final answer. Its `decide`
callback is scripted; application code supplies provider SDKs, prompts, and
response mapping when connecting a model.

## Define tools and an agent

Use `defineTool` for a handler with a description, `inputSchema`, `outputSchema`,
and `run(validatedInput, context)`. Both schemas follow Standard Schema V1.
The input schema must expose Standard JSON Schema input conversion for
`draft-2020-12`, or supply an explicit `inputJsonSchema` object. `defineAgent`
similarly requires a `resultSchema` with input conversion or `resultJsonSchema`.
Descriptors are owned, frozen JSON data; explicit descriptors assert agreement
with the validators, which remain authoritative. No schema or model SDK is a
runtime dependency of Tubeless.

Tool names start with a letter and contain letters, digits, underscores, or
hyphens, up to 128 characters. A call ID is a nonblank string of at most 256
characters, unique within its turn. Model data can select registered names and
supply arguments; it cannot register code or change execution controls.

`defineAgent` takes `id`, `inputSchema`, `resultSchema`, `initialState`, and
`decide`, with optional `tools`, `reduce`, `dryRun`, and `limits`. It returns a
pipeline with the single step and target `agent`. Its exact raw input, schema
transformed output, and literal ID work with ordinary `fromPipeline`,
`defineProject`, and `definePipelineCommand`. Automatic CLI flags still require
JSON Schema metadata on the agent's input schema.

## Decisions and state

`decide(state, context)` may return either of these shapes:

```ts
{ kind: "continue", calls: [{ id: "lookup-1", tool: "lookup", input: { query: "example" } }] }
{ kind: "finish", result: "The raw result schema input" }
```

The return type is intentionally `unknown`: every decision is checked, including
typed provider responses. `AgentDecision<typeof tools, RawResult>` is useful for
typed fixtures. Empty batches, duplicate call IDs, unknown names, extra envelope
or call fields, and malformed arguments fail. A decision cannot both finish and
schedule calls. A valid `undefined` final result is distinct from a missing
`result` property.

All arguments are validated before any handler in the batch starts. Input
transformations run once; each tool output and final result is validated once.
Independent calls may complete in any order, but `reduce(state, outcomes)` sees
decision order and runs once after the entire successful batch settles.
Dependencies between calls belong in a later turn.

State is owned by each invocation. Initialization and reducer commits copy and
freeze finite primitives, arrays, and plain records; undefined fields are allowed.
Cycles, class instances, functions, and resource handles are rejected. Keep
clients and file handles in application closures. Reducers return the next state;
omitting a reducer preserves state without accumulating observations.

`context.turn` starts at one. `context.stateVersion` starts at zero and advances
after each accepted batch, including when the reducer is omitted. The context
contains ordinary step services, immutable capability descriptions/input JSON
Schemas, and the raw final-result JSON Schema. It exposes no tool handlers.

## Failure, cancellation, and limits

A handler may throw `new ToolError(code, message)` for an expected domain failure.
The reducer receives `{ id, tool, ok: false, error: { code, message } }`, while the
tool's child run retains its failed lifecycle. An arbitrary error with the same
string code is fatal. Tool errors thrown by validators or reducers are fatal too.
Successful outcomes contain `{ id, tool, ok: true, value }` with validated outputs.

| Limit            | Default | Scope                                                            |
| ---------------- | ------- | ---------------------------------------------------------------- |
| `maxTurns`       | 20      | Decision invocations, including finish                           |
| `maxCalls`       | 100     | Whole-batch call admissions in this invocation                   |
| `maxDecisions`   | 100     | Decision callback admissions; excludes provider-internal retries |
| `maxConcurrency` | 1       | Simultaneous tool execution in this invocation                   |

Limits are safe integers; only `maxCalls` permits zero. A batch exceeding the
remaining call budget fails before any handler starts. Admitted calls consume
their allowance even if execution stops before dispatch. Finishing on the last
turn succeeds; continuing on that turn fails before tools run. Exhaustion fails
with `TUBELESS_AGENT_LIMIT_REACHED`, including bound, consumed count, requested
count, and scope in the error. Invalid decisions and state use
`TUBELESS_AGENT_INVALID_DECISION` and `TUBELESS_AGENT_INVALID_STATE`. Ordinary
pipeline child-error wrapping retains these source codes in the cause chain.

Cancellation stops new calls and waits for active work to settle. Fatal failures
also stop dispatch and drain active work, without cancelling sibling handlers.
Neither case calls the reducer or starts another decision. Handlers must cooperate
with `context.signal`; Tubeless cannot terminate an uncooperative promise.

Planning never initializes state or calls models, argument validators, or tools.
A dry run skips the agent unless `dryRun(state, context)` supplies a preview
decision source. Tools skip by default and require their own preview handler.
A skipped required tool or agent output fails finalization instead of inventing
an observation or answer.

## Inspection and recordings

Plans show the bounded turn pipeline and the agent's capability inventory and
limits. Runtime call IDs are not selectable `--step` targets. Definition identity
includes capabilities, input/result descriptor fingerprints, limits, and tool
pipeline identities. Set `implementationVersion` when changing prompts,
validators, reducers, or handlers whose semantics cannot be inferred from the graph.

Execution uses ordinary `decide`, `calls`, and `reduce` steps, with a new child run
per turn and per dispatched tool. Turn iteration relations identify the owning
agent. A tool run's `parentRunId` identifies its turn, and `itemKey` retains the
call ID. First-attempt trace attributes record `agent.runId`, `agent.turn`,
`agent.callId`, `agent.tool`, and `agent.parentAttemptId`. Decision, admission,
and reduction attempts record bounded decision/count/state-version summaries.
These existing trace v3 records round-trip through NDJSON and SQLite. State,
prompts, inputs, and outputs are not recorded automatically. Live progress keeps
at most 32 visible call groups and 32 recent turn groups.

This release slice executes handler tools in process. `pipelineTool`, subagents,
delegation depth, and shared tree admission arrive in the next stage. Agent
limits currently apply to one invocation; calling another agent manually from a
handler does not share them. Crash-safe resume and a provider integration recipe
remain later stages of the harness.
