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

## Connect a model

The [OpenAI agent recipe](../examples/agent-openai.ts) connects the same tools to
the Responses API using built-in `fetch`. Its
[decision adapter](../examples/agent-openai-decision.ts) is application code,
with no provider SDK or new Tubeless API. Replace `decide: openaiDecision` with
another provider's callback to keep the same tools, state, limits, and execution.

Set `OPENAI_API_KEY` in your environment, then run:

```sh
bun run tubeless -- run --trace logs/openai-agent.ndjson examples/agent-openai.ts -- \
  --question "Uppercase red, blue, and green in separate calls. Then count the characters in the uppercase results joined by single spaces."
```

The example defaults to `gpt-4.1-mini`; set `OPENAI_MODEL` to choose another
Responses model with function calling. This command makes paid API requests.
The tools themselves only transform and count text in process.

The model chooses which tools to call, their arguments, and how many calls to
request. A run can uppercase three words in one turn, consume those results in
a count call on the next turn, then finish with `RED BLUE GREEN` and a count of 14. The call sequence is model-selected; the recipe does not script those turns.
The command prints the validated final answer.

The adapter follows OpenAI's [function calling protocol](https://developers.openai.com/api/docs/guides/function-calling):

- Tool descriptors come from `context.capabilities`. Each function wraps the
  raw tool argument in `{ input }`, so even a string-valued tool has an object
  parameter schema. This recipe's schemas support OpenAI strict mode. When
  adapting other tools, check the provider's supported JSON Schema subset.
- An adapter-only `_finish` function wraps `context.resultJsonSchema` in
  `{ result }`. Calling it alone returns a Tubeless finish decision. Combining
  it with other calls fails before any tools start.
- Each request sends the current question and accumulated, validated outcomes.
  Tubeless owns the state; this example makes independent model requests with
  `store: false`, without a provider conversation or replayed reasoning items.
- Provider call IDs become turn-local Tubeless call IDs. The adapter checks the
  response envelope and parses arguments; Tubeless checks registered tools,
  call IDs, budgets, argument schemas, tool results, and the final answer.

The example allows six decisions and twelve tool calls, with up to three tools
running concurrently. Each HTTP request has a 30-second deadline and receives
the run's cancellation signal. HTTP errors, incomplete responses, refusals,
invalid JSON, and invalid decisions fail the run. There are no automatic
provider retries. Error messages omit HTTP response bodies.

The recipe also bounds model input in UTF-8 bytes. Questions may use up to
4 KiB; accumulated observations may use up to 16 KiB of serialized JSON. An
oversized question fails before the first model request. Oversized history fails
before committing the next state or requesting another decision. Accepted
observations remain complete, so later tools can use their exact text. The
adapter checks the complete encoded HTTP body against a 32 KiB limit before
every request, including instructions, schemas, and JSON escaping. These are
application byte budgets; they do not measure a selected model's token usage.

`plan`, `inspect`, and `graph` need no credentials and make no API requests. The
live example has no preview decision source: `--dry-run` skips the agent and
fails required finalization because there is no answer. Use the scripted recipe
for a credential-free executable preview. Importing the project also makes no
requests; `openai-agent` is registered in the
[example project](../examples/project/tubeless.project.ts).

CI replaces `fetch` with provider response fixtures while running real Tubeless
tools, reduction, and finalization. Run the command above separately for a live
provider check. Traces record turn/call lifecycles and summaries; prompts, state,
tool output, and credentials are not added to traces by this adapter.

The compiled turn graph stays `decide -> calls -> reduce`. Its execution history
expands with each chosen batch and turn; a model cannot rewrite dependency edges
or register executable code.

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

## Delegate to pipelines and subagents

Use `pipelineTool` to register an ordinary compiled pipeline or another agent in
the same tools registry. A schema-backed child needs only a description:

```ts
const tools = {
  research: pipelineTool(ResearchAgent, { description: "Research one question." }),
};
```

The tool uses the child's options schema for model arguments and returns its
exact finalized result. For different argument shapes or a schema-less child,
supply `inputSchema` and `mapOptions` together:

```ts
const tools = {
  count: pipelineTool(CounterPipeline, {
    description: "Count a question's characters.",
    inputSchema: questionSchema,
    mapOptions: ({ question }) => ({ text: question }),
  }),
};
```

The harness validates arguments, maps options, validates child options, and checks
child plans for the whole batch before starting any child. Each schema transform
runs once. Keep mappers free of side effects. A child owns its state and registry;
its finish returns a result to the parent, which can make further decisions.

Run the [delegation recipe](../examples/agent-delegation.ts) without credentials:

```sh
make run FILE=examples/agent-delegation.ts ARGS='--question "red blue"'
make run FILE=examples/agent-delegation.ts ARGS='--dry-run --question "red blue"'
```

The parent creates two child-agent calls, consumes their results in a later
ordinary summary-pipeline call, then finishes with
`Summary: 3 characters; RED | 4 characters; BLUE`. Each decision source is
scripted; it can be replaced with an application-owned model callback.

A failed child is recoverable only when all its failures are actual handler
`ToolError`s. Multiple expected failures become one bounded `TUBELESS_TOOL_ERRORS`
observation in pipeline order. Mixed failures, validation, finalization, model
callbacks, and cancellation remain fatal. Child pipelines inherit dry runs and
retain their own step policies; mark side effects or supply preview handlers.

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

| Limit            | Default | Scope                                                           |
| ---------------- | ------- | --------------------------------------------------------------- |
| `maxTurns`       | 20      | Decision invocations, including finish                          |
| `maxCalls`       | 100     | Whole-batch tool/child admissions across the subtree            |
| `maxDecisions`   | 100     | Subtree decision admissions; excludes provider-internal retries |
| `maxDepth`       | 4       | Pipeline-tool delegation edges below this agent                 |
| `maxConcurrency` | 1       | Active decision callbacks and leaf step handlers in the subtree |

Limits are safe integers; `maxCalls` and `maxDepth` permit zero. A batch exceeding the
remaining call budget fails before any handler starts. Admitted calls consume
their allowance even if execution stops before dispatch. Finishing on the last
turn succeeds; continuing on that turn fails before tools run. Exhaustion fails
with `TUBELESS_AGENT_LIMIT_REACHED`, including bound, consumed count, requested
count, and scope in the error. Invalid decisions and state use
`TUBELESS_AGENT_INVALID_DECISION` and `TUBELESS_AGENT_INVALID_STATE`. Ordinary
pipeline child-error wrapping retains these source codes in the cause chain.

The root invocation owns shared counters and execution permits. Child limits can
tighten the bounds; every ancestor limit still applies. Concurrent sibling
admissions check and charge the entire batch atomically, with no refunds.
`maxTurns` remains local to each agent. A `pipelineTool` call consumes one call
and one delegation edge; calls and decisions inside that child also consume
ancestor budgets. Ordinary pipeline steps consume leaf permits, not call counts.
A depth of zero permits handler tools but rejects pipeline tools.

Decision callbacks release their permits before child dispatch. Wrappers waiting
on descendants hold no permit, so nested execution works with concurrency one.
The scope survives ordinary `fromPipeline`, `forEachPipeline`, and iteration
between agents. Use registered pipeline tools for delegation: manually calling
`run` from a handler is outside this composition contract. Schema validation,
mapping, reducers, and finalizers are not counted as leaf handlers. The outer
pipeline's DAG `maxConcurrency` remains a separate control.

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
call ID. Handler-tool first-attempt trace attributes record `agent.runId`, `agent.turn`,
`agent.callId`, `agent.tool`, and `agent.parentAttemptId`. Decision, admission,
and reduction attempts record bounded decision/count/state-version summaries.
These existing trace v3 records round-trip through NDJSON and SQLite. State,
prompts, inputs, and outputs are not recorded automatically. Live progress keeps
at most 32 visible call groups and 32 recent turn groups.

The harness executes in process. Crash-safe resume remains a later stage.
