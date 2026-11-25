# Agents and durable execution

`tubeless/agent` builds an ordinary pipeline around a bounded decision loop: each
turn requests a decision, validates it, runs a batch of registered tools, and
reduces their outcomes into the next state. A finish decision validates and returns
the result. Two factories share that loop:

- `defineAgent({ id, model })` uses a model as the decision source. The default
  `{ task } → { answer }` shape serves prompts and the `tubeless agent` REPL; add
  `inputSchema`, `task` and `resultSchema` for a typed step over pipeline data.
- `defineAgentLoop({ id, decide, … })` takes your own `decide` callback and state
  for scripted, rule-based or hand-integrated decisions.

The [scripted agent recipe](../examples/agent.ts) needs no credentials:

```sh
make run FILE=examples/agent.ts ARGS='--question "hello tubeless"'
make run FILE=examples/agent.ts ARGS='--dry-run --question "preview"'
```

## Default model-backed agent

For a terminal prompt loop, run `tubeless agent --model gpt-5.4-mini`. Prompts share
a [session](#chat-sessions); `/model <name>` switches models and `/clear` starts
fresh. `--prompt 'task'` runs once, `--model-module ./model.ts` loads a custom
provider, and `--store` or `--trace` records runs for `tubeless history` and Studio.
`tubeless agent <agent-id|file>` runs an existing agent that keeps the default
`{ task }` / `{ answer }` schemas; use `tubeless run` for typed agents. See the
[agent CLI](./cli.md#prompt-a-workspace-agent) and
[agent selection](./cli.md#select-a-defined-agent).

In code, supply a model and an ID:

```ts
import { defineAgent } from "tubeless/agent";
import { openaiModel } from "tubeless/agent/openai";

const agent = defineAgent({ id: "coding", model: openaiModel() });
const { answer } = await agent.runOrThrow(
  { task: "Find and fix the failing test, then verify the change." },
  undefined,
  { cwd: "/path/to/project" }
);
```

The factory supplies the input/result schemas, the [default tools](#default-workspace-tools),
a coding prompt, conversation state and reduction. Add `instructions`, `tools`
(extend or override defaults) and `limits`. The result is an ordinary pipeline:
`pipelineTool`, project registration, traces and cancellation all work.

With project context (the default for `{ task }` agents), the prompt loads
`AGENTS.md` files from the nearest repository root down to the run's cwd; more
specific files win. Missing files are fine; unreadable, non-text or oversized
ones fail before any model request. Discovery beyond startup is model-driven, not
an access control. Set `projectContext: false` for a short task-neutral prompt
(the default for typed agents). A live run resolves cwd to its physical directory
once before any decision or tool call. Tasks are limited to 16 KiB.

### Choose a model provider

`model` accepts any `AgentModel`. Two optional, dependency-free adapters share option
names, so switching providers changes one import. A third adapter accepts any
[Vercel AI SDK](#vercel-ai-sdk) language model:

```ts
import { anthropicModel } from "tubeless/agent/anthropic"; // ANTHROPIC_API_KEY
import { openaiModel } from "tubeless/agent/openai"; // OPENAI_API_KEY
```

| Option              | `anthropicModel()`                                                         | `openaiModel()`                                     |
| ------------------- | -------------------------------------------------------------------------- | --------------------------------------------------- |
| `model`             | `ANTHROPIC_MODEL`, else `claude-opus-5-5`                                  | `OPENAI_MODEL`, else `gpt-5.4-mini`                 |
| `apiKey`            | `ANTHROPIC_API_KEY` (`x-api-key`); else `ANTHROPIC_AUTH_TOKEN` as a bearer | `OPENAI_API_KEY` (bearer)                           |
| `authToken`         | Explicit bearer token, for compatible servers                              | Not applicable                                      |
| `baseUrl`           | `ANTHROPIC_BASE_URL`, else `https://api.anthropic.com` (no `/v1`)          | `OPENAI_BASE_URL`, else `https://api.openai.com/v1` |
| `reasoningEffort`   | Omitted; `low` through `max`                                               | Omitted; `none` through `max`                       |
| `compactAfterBytes` | 768 KiB; `null` disables compaction                                        | Same                                                |
| `timeoutMs`         | 600000 per decision                                                        | 60000 per decision                                  |
| `maxRetries`        | 2 retries per HTTP request (408, 429, 5xx, dropped connection); `0` off    | Same                                                |
| `maxTokens`         | 32000 output tokens per request, thinking included                         | Not applicable                                      |
| `strict`            | `true`; `false` sends tools without strict mode                            | Always strict                                       |
| `promptCaching`     | `true` (5 minutes), `"5m"`, `"1h"`, or `false`                             | Not applicable                                      |

- Environment values are read when a decision executes, so imports, plans and dry
  runs need no credentials. Options override the environment.
- Live runs make paid API requests and execute workspace tools with the host's
  permissions. Dry runs skip the model and have no final answer.
- `timeoutMs` covers one decision, including compaction. A timeout fails the run
  (`failed`, not `cancelled`); only the run's abort signal cancels it.
- Reasoning settings are omitted by default so models that reject them stay
  compatible. Support depends on the model.
- Provider requests do not follow redirects; configure the final base URL.
- Tool and result schemas must fit the provider's strict subset. The adapters wrap
  tool arguments in `{ input }` and reject `$ref`-style references locally (supply an
  inline `inputJsonSchema` instead). OpenAI additionally requires every object to set
  `additionalProperties: false` and list all properties in `required`. Anthropic
  strict mode allows optional properties, but at most 20 tools per request including
  the finish tool; set `strict: false`, narrow `defaultTools`, or use
  [code mode](#code-mode) for larger sets. The AI SDK adapter does not require closed
  objects or every property. Failures surface at definition as
  `TUBELESS_AGENT_INVALID_DEFINITION` (via `AgentModel.checkDescriptors`, which the
  adapters implement; wrapping an adapter in your own function drops that hook).
- Large tool batches are shown to the model as marked previews (`truncated: true`)
  while the harness keeps full outcomes. Compaction can lose exact history, so the
  prompt tells the model to re-read sources when exact text matters.

Executable recipes: [OpenAI](../examples/agent-model.ts),
[Claude](../examples/agent-model-anthropic.ts), and
[Vercel AI SDK](../examples/agent-model-ai-sdk.ts).

### Vercel AI SDK

`aiSdkModel()` from `tubeless/agent/ai-sdk` runs any Vercel AI SDK language model
(`ai` package, v7 or later). The core package stays dependency-free; install `ai`
only when you import this entry. Provider packages such as `@ai-sdk/openai` stay
in your application.

```ts
import { openai } from "@ai-sdk/openai";
import { defineAgent } from "tubeless/agent";
import { aiSdkModel } from "tubeless/agent/ai-sdk";

export const agent = defineAgent({
  id: "ai-sdk-agent",
  model: aiSdkModel({ model: openai("gpt-5.4-mini") }),
});
```

The same options accept `anthropic("claude-opus-5-5")` from `@ai-sdk/anthropic`,
`google("gemini-2.5-flash")` from `@ai-sdk/google`, `groq("llama-3.3-70b-versatile")`
from `@ai-sdk/groq`, any other AI SDK `LanguageModel`, or an AI Gateway id such as
`"openai/gpt-5.4-mini"`. A gateway id is resolved by `ai` and makes a network request.

Tool calls and structured final answers use the same decision shape as the native
adapters: tool arguments are `{ input }`, and the finish tool is `{ result }`.
`$ref` schemas fail at definition. The adapter keeps a plain JSON transcript of
text, tool calls, and tool results, and sends tool-call provider metadata (such
as thought signatures) back on the next request. It does not compact history,
cache prompts, replay reasoning content, or stream assistant text. `reasoningEffort`
is the AI SDK 7 `reasoning` option and is omitted unless you set it. `timeoutMs` defaults
to 60000 and fails the run when reached. `maxRetries` (default 2) is the AI SDK
retry count for one decision request. A text-only response gets one reminder, then
fails. History that cannot fit in
1 MiB fails the decision; large tool results are marked `truncated: true`.

```sh
npm install ai @ai-sdk/openai
```

Recipe: [examples/agent-model-ai-sdk.ts](../examples/agent-model-ai-sdk.ts).

`AgentModel` is a provider-independent callback: given the task, instructions, its
previous plain-data `conversation` (initially `null`) and the latest tool outcomes,
it returns an untrusted `decision` plus the next `conversation`. Tubeless validates
the decision and owns a frozen copy of the state.

### Prompt caching and usage traces

OpenAI uses automatic prompt caching. Anthropic caches the shared system
instructions (so separate tasks reuse tools and instructions, subject to the
provider's minimum length) and the growing conversation. Use `promptCaching: "1h"`
for longer pauses at a higher write price, or `false` for servers that reject cache
controls. See [OpenAI caching](https://developers.openai.com/api/docs/guides/prompt-caching)
and [Anthropic caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching).

Compaction thresholds are byte counts, not tokens, and do not guarantee a model's
context window fits. For smaller-context models set a lower `compactAfterBytes`
from observed usage; `null` disables compaction but still enforces the 1 MiB
request and 2 MiB response limits.

With tracing enabled (`--trace`, `--store` or a `tracing.exporter`), every provider
request emits a `step.attempted` event with `agent.model.*` attributes: `provider`,
`name`, `operation` (`decision` or `compaction`), `request`, `durationMs`,
`httpStatus`, `inputTokens`, `outputTokens`, cache read/write counters
(`cacheReadTokens`, `cacheWriteTokens`, plus per-lifetime variants),
`uncachedInputTokens` and `reasoningTokens`. Only allowlisted numeric usage and
request metadata are recorded, never prompts, responses or credentials. An absent
counter was never reported; zero was reported as zero. Retries are separate events.

`tubeless history <run-id>` sums usage per agent and run (`--json` adds `usage` per
turn and agent, `subtreeUsage` including descendants, and `agentHistory.usage` for
the run). `requestsWithoutUsage` above zero makes the sums a lower bound. Tubeless
reports tokens only; apply your model's prices yourself.

### Chat sessions

Each `defineAgent` run starts a fresh conversation. To continue one across prompts,
wrap the agent in a session:

```ts
import { createAgentSession, defineAgent } from "tubeless/agent";

const agent = defineAgent({ id: "assistant", model: openaiModel() });
const session = createAgentSession(agent);
await session.runOrThrow({ task: "Summarize the open issues in README.md" });
await session.runOrThrow({ task: "Now draft a fix for the first one" }); // same conversation
await saveConversation(session.conversation); // plain provider-owned data
const resumed = createAgentSession(agent, { conversation: await loadConversation() });
```

- The conversation advances only when a run completes; failed, cancelled and dry
  runs keep the previous one. `clear()` starts fresh.
- Runs are sequential: a run during another rejects with `TUBELESS_AGENT_SESSION_BUSY`.
  Each run still gets fresh limits and its own trace.
- A persisted conversation must come from the same provider adapter. Typed agents
  work; `defineAgentLoop` agents have no provider conversation and are rejected.
- Sessions use the configuration captured at `defineAgent` time.
- With a [durable agent](#durable-execution), replaying a completed task restores its
  final conversation without repeating work. Use a distinct execution key per task.
  Checkpoints written by older versions may lack it: replay returns the saved answer
  outside a session but rejects inside one with
  `TUBELESS_AGENT_SESSION_CHECKPOINT_INCOMPLETE`.

The [credential-free chat recipe](../examples/agent-chat.ts) shows the REPL flow.

### Typed inputs and results

`inputSchema` plus a `task` mapper (required together) runs the same model-backed
agent over typed pipeline data. The mapper produces the task text; with
`resultSchema` the model finishes against its JSON Schema and the harness validates
the result. Without them the types stay `{ task }` and `{ answer }`. It composes like
any child pipeline, as in the [extract recipe](../examples/agent-extract.ts):

```ts
const TriageAgent = defineAgent({
  id: "triage-agent",
  model: openaiModel(),
  inputSchema: extracted, // { files: string[] }
  resultSchema: triage, // { files: { path, kind }[] }
  task: ({ files }) => `Classify each extracted file:\n${files.map((f) => `- ${f}`).join("\n")}`,
  defaultTools: ["read"],
});
const classify = fromPipeline("classify", {
  pipeline: TriageAgent,
  dependsOn: [extract],
  mapOptions: ({ extract }) => extract,
});
```

Typed agents default to `projectContext: false`: your `instructions` become the
main guidance. Grant only the tools the task needs with `defaultTools`.

### Compatible APIs

Both adapters work with any server implementing the same protocol (routers,
inference platforms, self-hosted servers, gateways). Set `baseUrl` (or
`OPENAI_BASE_URL` / `ANTHROPIC_BASE_URL`), the provider's credential and model ID,
then disable what the server lacks:

- `openaiModel()` needs the **Responses API** (`POST {baseUrl}/responses`), not only
  Chat Completions; `baseUrl` includes the version path. Set `compactAfterBytes: null`
  unless the server implements `/responses/compact`. The adapter always sends
  `store: false` and `include: ["reasoning.encrypted_content"]`.
- `anthropicModel()` needs the **Messages API** (`POST {baseUrl}/v1/messages`);
  `baseUrl` excludes `/v1`. Most compatible servers want a bearer token: pass
  `authToken` (or `ANTHROPIC_AUTH_TOKEN`) instead of `apiKey`, and leave
  `ANTHROPIC_API_KEY` unset (it wins when both are set). Set `strict: false`,
  `promptCaching: false` and `compactAfterBytes: null` unless the server documents
  strict tool use, `cache_control` and on-demand compaction.

```ts
// OpenRouter through its Responses endpoint.
export const RouterAgent = defineAgent({
  id: "router-coding",
  model: openaiModel({
    baseUrl: "https://openrouter.ai/api/v1",
    apiKey: process.env.OPENROUTER_API_KEY,
    model: "anthropic/claude-opus-5",
    compactAfterBytes: null,
  }),
});

// Baseten through its Messages endpoint (bearer auth; x-api-key is rejected).
export const BasetenAgent = defineAgent({
  id: "baseten-coding",
  model: anthropicModel({
    baseUrl: "https://inference.baseten.co",
    authToken: process.env.BASETEN_API_KEY,
    model: "deepseek-ai/DeepSeek-V4-Pro",
    strict: false,
    promptCaching: false,
    compactAfterBytes: null,
  }),
});
```

`process.env` in a module is read at import. To keep credentials out of imports and
plans, set the conventional variables (`OPENAI_BASE_URL`, `OPENAI_API_KEY`,
`ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`) and pass only the remaining options.
[`examples/agent-providers.ts`](../examples/agent-providers.ts) registers a named
provider for the CLI.

Base URLs as of October 2026; check each provider for model IDs and limits:

| Provider          | `openaiModel({ baseUrl })`                      | `anthropicModel({ baseUrl })`                        | Notes                                                                    |
| ----------------- | ----------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------ |
| OpenRouter        | `https://openrouter.ai/api/v1`                  | `https://openrouter.ai/api`                          | Bearer auth (`authToken`); model slugs such as `anthropic/claude-opus-5` |
| Baseten           | Not available (Chat Completions only)           | `https://inference.baseten.co`                       | Messages is in beta; bearer auth (`authToken`)                           |
| Fireworks         | `https://api.fireworks.ai/inference/v1`         | `https://api.fireworks.ai/inference`                 | Bearer auth; `accounts/fireworks/models/...` model IDs                   |
| DeepSeek          | `https://api.deepseek.com`                      | `https://api.deepseek.com/anthropic`                 | Ignores `cache_control`                                                  |
| Moonshot (Kimi)   | `https://api.moonshot.ai/v1`                    | `https://api.moonshot.ai/anthropic`                  | Bearer auth (`authToken`)                                                |
| Amazon Bedrock    | `https://bedrock-mantle.{region}.api.aws/v1`    | `https://bedrock-mantle.{region}.api.aws/anthropic`  | Bedrock API key; Bedrock model IDs                                       |
| Microsoft Foundry | `https://{resource}.openai.azure.com/openai/v1` | `https://{resource}.services.ai.azure.com/anthropic` | `model` is the deployment name                                           |
| Ollama            | `http://localhost:11434/v1`                     | `http://localhost:11434`                             | Local keys can be any placeholder value                                  |
| vLLM              | `http://{host}:8000/v1`                         | `http://{host}:8000`                                 | Self-hosted                                                              |
| LiteLLM proxy     | `http://localhost:4000/v1`                      | `http://localhost:4000`                              | Supports `/responses/compact`; bridges providers without either API      |

Groq's Responses endpoint rejects the `store` and `include` fields the OpenAI
adapter always sends, and Google Vertex AI uses OAuth with the model in the request
path; reach either through a gateway such as LiteLLM. Servers vary in protocol
fidelity, so try a new provider on a small task first.

## Evaluate your own agent

Pass `createAgentTranscriptCollector()` from `tubeless/testing` as the agent's
`transcript` option, then call `collector.assertComplete()` before asserting on
`collector.records`. Completeness fails on capture errors, omissions, byte-limit
markers, sequence gaps or a missing end marker; pass a run ID to check one run. A
complete recording can still describe a failed or cancelled run, so check the result
separately. `maxBytes` (default 16 MiB) bounds retention.

`createAgentTestWorkspace(files)` writes text fixtures into an owned temporary
directory and returns its `cwd`. `workspace.assertUnchanged()` verifies the files
(optionally a relative-path subset) and always `await workspace.close()` in
`finally`. Requires Node or Bun.

```ts
import { createAgentTestWorkspace, createAgentTranscriptCollector } from "tubeless/testing";

const workspace = await createAgentTestWorkspace({ "input.txt": "fixture\n" });
const collector = createAgentTranscriptCollector();
try {
  const agent = defineAgent({ id: "evaluated", model, transcript: collector });
  const result = await agent.runOrThrow(
    { task: "Read input.txt without changing files." },
    undefined,
    { cwd: workspace.cwd }
  );
  collector.assertComplete();
  await workspace.assertUnchanged();
  // Use your assertion library with result and collector.records.
} finally {
  await workspace.close();
}
```

The [scripted evaluation recipe](../examples/agent-evaluation.ts) runs without
credentials. Use scripted models in CI and make live provider runs an explicit choice.

## Connect a model

Providers with a Vercel AI SDK package can use [`aiSdkModel()`](#vercel-ai-sdk)
instead of a hand-rolled callback. To integrate any other provider, write a
`decide` callback for `defineAgentLoop`
and keep the same tools, state, limits and execution. The
[OpenAI recipe](../examples/agent-openai.ts) does this with built-in `fetch` and a
[decision adapter](../examples/agent-openai-decision.ts) that is application code,
not a Tubeless API:

```sh
export OPENAI_API_KEY=...
bun run tubeless -- run --trace logs/openai-agent.ndjson examples/agent-openai.ts -- \
  --question "Uppercase red, blue, and green in separate calls. Then count the characters."
```

An adapter maps `context.capabilities` to provider tool descriptors, wraps
`context.resultJsonSchema` in a finish function, and converts the response to a
decision. Tubeless owns state and validates tools, call IDs, budgets, arguments and
results, so a model can select registered names but cannot add tools or change
limits. Bound request size and deadlines in the adapter, and forward the run's
cancellation signal.

Like every agent, this recipe also advertises the default workspace tools,
including `bash`, which execute with the host's permissions. There is no per-call
approval or sandbox. `plan`, `inspect` and `graph` make no requests; `--dry-run`
skips the agent and fails required finalization because no answer exists. Use the
scripted recipe for a credential-free preview.

## Connect MCP servers

The optional `tubeless/agent/mcp` entrypoint connects
[Model Context Protocol](https://modelcontextprotocol.io) servers over Streamable
HTTP (`url`) or local stdio (`command`) and exposes their tools to any agent. It is
dependency-free.

```ts
import { defineAgent } from "tubeless/agent";
import { connectMcpServers } from "tubeless/agent/mcp";
import { openaiModel } from "tubeless/agent/openai";

await using mcp = await connectMcpServers({
  docs: { url: "https://mcp.example.com/mcp", headers: { Authorization: `Bearer ${token}` } },
  files: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "."] },
});
const agent = defineAgent({ id: "mcp-agent", model: openaiModel(), tools: mcp.tools });
```

- Tools are named `<server>__<tool>` (characters outside `[A-Za-z0-9_-]` become
  `_`); server names use letters, digits and hyphens. `mcp.tools` is an ordinary
  registry: spread it beside custom tools, or pass `tools: ["name"]` per server to
  expose an allowlist. `timeoutMs` (default 60000) applies per request.
- Inventories are discovered once at connection. A server that changes its tools
  changes the agent's definition identity, which matters for durable checkpoints.
- Connect inside the function that runs the agent, not at module scope, so importing
  a project starts no processes, and close after the last run, as in the
  [MCP recipe](../examples/agent-mcp.ts). Calls after `close()` fail.
- Input schemas are rewritten to strict form (optional properties become required
  and nullable; nulls are stripped before the call). Free-form objects, recursive
  references, tuples, `oneOf`/`allOf`, conditionals and optional properties that
  already accept `null` are rejected at connection time.
- Results are `{ content, structuredContent? }`. An object `outputSchema` types
  `structuredContent` in [code-mode declarations](#code-mode); Tubeless does not
  validate it. An `isError` result becomes a recoverable `MCP_TOOL_ERROR`;
  JSON-RPC errors become `MCP_PROTOCOL_ERROR`; timeouts, transport failures and
  exited servers are fatal. Cancellation sends `notifications/cancelled`.
- MCP tools keep `replay: "unsafe"` and are skipped in dry runs; server annotations
  are not trusted to change either. The client supports no sampling, roots or
  elicitation.
- Each server is a separate authority outside `AgentEnvironment`: stdio servers
  inherit the host environment plus `env`, and HTTP headers are sent as given.
  HTTP does not follow redirects; configure the final endpoint.

## Code mode

Code mode is off by default. Set `codemode: true` on `defineAgent` or
`defineAgentLoop`, or pass `tubeless agent --codemode`, to advertise one `codemode`
tool instead of the registry. Each call runs a JavaScript async function body that
calls the registered tools (defaults, custom, pipeline and MCP) as typed async
functions and returns a JSON value. The agent needs at least one tool.

### When to use code mode

Measure first. In live evaluations code mode matched direct calls on reliability
but did not cut turns or time for small coding tasks or short lookups, because most
turns exist for the model to see a result. It helps when a script can do work the
model need not see:

- **Loops and aggregation:** read every file in a listing, filter or sum, return one total.
- **Chains through typed outputs:** an output schema (including an MCP
  `outputSchema`) shows the model what each tool returns so it can chain calls.
- **Large inventories:** one tool replaces many descriptors (about 10 KB of
  declarations per 50 tools, within a 48 KiB budget).

Leave it off for interactive coding, small tool sets, and steps that each depend on
the previous result.

```ts
await using mcp = await connectMcpServers({ docs: { url: "https://mcp.example.com/mcp" } });
const agent = defineAgent({
  id: "codemode-agent",
  model: openaiModel(),
  tools: mcp.tools,
  codemode: true,
});
```

For `defineAgentLoop`, `codemode: true` makes `AgentCall<Registry, true>`,
`AgentDecision<Registry, Result, true>` and `AgentOutcome<Registry, true>` name only
`codemode`: call input is `{ code }` and a successful outcome's value is a
`CodemodeResult`. Decisions naming a registered tool directly fail as unknown. See
the [code-mode recipe](../examples/agent-codemode.ts), which runs a scripted survey
without credentials.

The tool description contains generated declarations in registry order, for example
`tools.read({ path, startLine, maxLines })`. Inputs come from each tool's JSON
Schema; outputs come from the output schema when it has a Standard JSON Schema
converter, else `unknown`. Names that are not identifiers need bracket access, such
as `tools["docs__search-pages"]`. Declarations are bounded to 48 KiB; expose fewer
tools (for example with MCP allowlists) if the inventory exceeds it.

**Limits and results.** `{ code }` is up to 65,536 characters. A completed script
returns `{ result, logs, logsTruncated }`: the JSON return value (up to 16 KiB;
`undefined` becomes `null`) and up to 200 `console.*` lines or 4 KiB of logs. These
become recoverable observations:

- `CODEMODE_SCRIPT_ERROR`: syntax errors (including TypeScript syntax) and uncaught
  exceptions.
- `CODEMODE_TIMEOUT`: the script, including un-awaited calls, exceeded 60 seconds;
  running calls are cancelled.
- `CODEMODE_RESULT_TOO_LARGE`: the return value exceeded 16 KiB (its tool calls
  already ran).
- `CODEMODE_SANDBOX_ERROR`: the worker stopped, for example on memory exhaustion.

**Tool calls inside a script** use the same validation and admission as direct calls.
A recoverable `ToolError`, invalid arguments (`CODEMODE_INVALID_CALL`) or a
non-JSON result (`CODEMODE_INVALID_RESULT`) reject the call's promise with an
`Error` carrying `code` and `message`, which the script may catch. Handler
exceptions, limit exhaustion and cancellation stop the script and fail the run.
Each call counts against `maxCalls`, and `maxConcurrency` bounds `Promise.all`
fan-out. Each script call is a child run (item key `<call id>.<n>`), so `--trace`,
`history` and Studio show what the script did.

**Durability and dry runs.** Durable agents checkpoint a script as one call: it is
replay-safe only when every reachable tool is. An interrupted script becomes
`TUBELESS_AGENT_CALL_INTERRUPTED`, and nested calls are not journaled individually.
Dry runs execute scripts, and each call follows its tool's own dry-run policy
(`read`, `list` and `search` run; `write`, `edit`, `bash` and MCP tools are
skipped, and a script that awaits a skipped result fails the preview).

**Executors.** `codemode: true` uses `createNodeCodemodeExecutor()` (also from
`tubeless/agent/node`): a fresh Node or Bun worker thread with heap limits in a
`node:vm` context without `eval`, `Function`, WebAssembly, `process`, `require`,
`fetch` or timers, an empty environment, and JSON-only values crossing in. This is
best-effort isolation, not a security boundary; treat scripts like `bash`, as code
running with the host's authority. Without file-based worker threads (for example
Cloudflare Workers), a run without an executor fails with
`TUBELESS_AGENT_CODEMODE_UNAVAILABLE`; use
[`createWorkerLoaderCodemodeExecutor`](./deploy-cloudflare.md#code-mode-agents-on-workers).
Pass your own with `codemode: { executor }`: implement `CodemodeExecutor.execute(execution, signal)`
to run `execution.code` with `tools` and `console`, forward calls to
`execution.call(name, inputJson)`, return the JSON result text and console lines (or
`{ ok: false, message }`), and stop when `signal` aborts. Tubeless keeps deadlines,
budgets and failure classification for every executor.

## Define tools and an agent

Every agent, including children, gets `read`, `write`, `edit`, `bash`, `list` and
`search` unless narrowed. Pass `defaultTools` to grant a subset, for example
`["read", "list", "search"]` for an agent that must not write or run commands; `[]`
grants none, and unknown names fail at definition. `tools` adds custom capabilities,
and an entry named like a built-in replaces it. Only the merged registry is
advertised; other names fail as unknown. `AgentCall`, `AgentDecision` and
`AgentOutcome` take the selection as the last type parameter
(`AgentCall<Registry, false, "read" | "list">`); narrow outcomes by both `ok` and
`tool` before reading a value.

`defineTool` takes a description, `inputSchema`, `outputSchema` and
`run(validatedInput, context)`. Schemas follow Standard Schema V1; the input schema
must expose Standard JSON Schema conversion for `draft-2020-12`, or you supply an
`inputJsonSchema`. `defineAgentLoop` likewise needs a `resultSchema` with conversion
or a `resultJsonSchema`. Validators stay authoritative over explicit descriptors.
Tool names start with a letter, use letters, digits, `_` or `-`, and are at most 128
characters.

`defineAgentLoop` takes `id`, `inputSchema`, `resultSchema`, `initialState` and
`decide`, plus optional `tools`, `reduce`, `dryRun` and `limits`. It returns a
pipeline with a single step and target `agent` that works with `fromPipeline`,
`defineProject` and `definePipelineCommand`. Automatic CLI flags need JSON Schema
metadata on the input schema.

### Embed an agent in a pipeline

Use `fromPipeline` as for any child pipeline. The
[composition recipe](../examples/agent-pipeline.ts) feeds a delegating agent's
validated answer into a dependent report step, with scripted decisions so it runs
and previews without credentials:

```sh
make run FILE=examples/agent-pipeline.ts ARGS='--question "red missing"'
make run FILE=examples/agent-pipeline.ts ARGS='--dry-run --question "red missing"'
```

Recording the parent with `--trace` or `--store` exposes the same child-agent
history as recording the agent directly. A child failure or cancellation prevents
dependent steps from running.

## Default workspace tools

| Tool     | Arguments                                   | Result and bounds                                                                                            |
| -------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `read`   | `path`, optional `startLine` and `maxLines` | UTF-8 content; up to 200 lines by default (max 2,000) and 16 KiB; rejects binary files.                      |
| `write`  | `path`, `content`                           | Creates parent directories; creates or replaces the file.                                                    |
| `edit`   | `path`, `oldText`, `newText`                | Replaces one exact match; missing or ambiguous matches are a recoverable error and write nothing.            |
| `bash`   | `command`, optional `cwd` and `timeoutMs`   | stdout, stderr, exit code, signal. Defaults to 30 seconds, maximum 5 minutes; output capped at 16 KiB.       |
| `list`   | optional `path`                             | Up to 200 entries with kinds and a truncation flag.                                                          |
| `search` | `query`, optional `path`                    | Case-sensitive literal search; up to 50 matches and 16 KiB. Skips binary, oversized, `.git`, `node_modules`. |

- Model descriptors require every option, accepting `null` for the default;
  application calls may omit them. Files up to 1 MiB; named pipes and devices are
  rejected.
- Paths resolve from `context.cwd` (absolute paths are accepted), and `bash.cwd`
  from the same directory. These are host filesystem and shell operations with the
  process's permissions; **`cwd` is not a sandbox**.
- Filesystem and command-start failures are recoverable `ToolError` observations; a
  nonzero exit or timeout is reported in the result. Cancellation is fatal and waits
  for the command to close; on POSIX the process group gets a signal, escalating to
  SIGKILL after 250 ms. Descendants that escape the group may survive.
- Read, list and search run in dry runs; write, edit and bash are skipped, and a
  turn requiring a skipped result fails.
- Calls in a batch may run concurrently; put dependent filesystem changes in
  successive turns. Writes and edits to one file are serialized in-process and
  replaced atomically (staged in a sibling temp directory, so the destination
  directory must be writable and searchable). Symlinks are followed; permissions
  are preserved; other hard links keep the old contents. Operations are not
  transactions across calls and not crash-durable.
- Actions appear as step progress and scoped logs (paths, command previews, counts),
  never file contents or command output. Custom handlers can add detail with
  `context.reportProgress({ completed: 0, message })` and `context.log`.

The [workspace recipe](../examples/agent-workspace.ts) uses all six defaults and a
custom tool with scripted decisions and real filesystem operations. It creates or
replaces a demo file:

```sh
make run FILE=examples/agent-workspace.ts ARGS='--directory .tubeless/agent-tools-demo'
```

## Delegate to pipelines and subagents

`pipelineTool` registers a compiled pipeline or another agent in the tools registry.
A schema-backed child needs only a description; the child's options schema becomes
the model's arguments and the tool returns its finalized result:

```ts
const tools = {
  research: pipelineTool(ResearchAgent, { description: "Research one question." }),
};
```

For different argument shapes or a schema-less child, supply `inputSchema` and
`mapOptions` together:

```ts
const tools = {
  count: pipelineTool(CounterPipeline, {
    description: "Count a question's characters.",
    inputSchema: questionSchema,
    mapOptions: ({ question }) => ({ text: question }),
  }),
};
```

Arguments are validated and child plans checked for the whole batch before any child
starts; keep mappers side-effect free. A child owns its state and registry and
returns a result to the parent. The
[delegation recipe](../examples/agent-delegation.ts) runs without credentials:

```sh
make run FILE=examples/agent-delegation.ts ARGS='--question "red blue"'
make run FILE=examples/agent-delegation.ts ARGS='--dry-run --question "red blue"'
```

A failed child is recoverable only when all its failures are handler `ToolError`s
(several become one bounded `TUBELESS_TOOL_ERRORS` observation). Mixed failures,
validation, finalization, model callbacks and cancellation are fatal. Children
inherit dry runs and keep their own step policies; mark side effects or supply
preview handlers.

## Decisions and state

`decide(state, context)` returns one of:

```ts
{ kind: "continue", calls: [{ id: "lookup-1", tool: "lookup", input: { query: "example" } }] }
{ kind: "finish", result: "The raw result schema input" }
```

The return type is `unknown` because every decision is validated, including typed
provider responses; `AgentDecision<typeof tools, RawResult>` helps typed fixtures.
Empty batches, duplicate call IDs, unknown tools, extra fields and malformed
arguments fail, and a decision cannot both finish and schedule calls.

All arguments in a batch are validated before any handler starts. Calls may finish in
any order, but `reduce(state, outcomes)` sees decision order and runs once after the
whole batch succeeds. Put dependencies between calls in a later turn.

State is owned per invocation and must be finite primitives, arrays and plain
records; cycles, class instances, functions and handles are rejected, so keep
clients in application closures. Reducers return the next state; with no reducer,
state is unchanged. `context.turn` starts at one and `context.stateVersion` at zero.
The context carries step services, immutable capability descriptions and the final
result JSON Schema, never tool handlers.

## Failure, cancellation, and limits

A handler throws `new ToolError(code, message)` for an expected domain failure; the
reducer receives `{ id, tool, ok: false, error: { code, message } }`. Any other error
is fatal, as are `ToolError`s thrown by validators or reducers. Successes arrive as
`{ id, tool, ok: true, value }`.

Handler failures include `waitForInput` readers and their preview handlers inside
pipeline tools.

| Limit            | Default | Scope                                                           |
| ---------------- | ------- | --------------------------------------------------------------- |
| `maxTurns`       | 20      | Decision invocations, including finish                          |
| `maxCalls`       | 100     | Whole-batch tool/child admissions across the subtree            |
| `maxDecisions`   | 100     | Subtree decision admissions; excludes provider-internal retries |
| `maxDepth`       | 4       | Pipeline-tool delegation edges below this agent                 |
| `maxConcurrency` | 1       | Active decision callbacks and leaf step handlers in the subtree |

- A batch exceeding the remaining call budget fails before any handler starts.
  Finishing on the last turn succeeds; continuing on it fails. Exhaustion fails with
  `TUBELESS_AGENT_LIMIT_REACHED`; invalid decisions and state use
  `TUBELESS_AGENT_INVALID_DECISION` and `TUBELESS_AGENT_INVALID_STATE`.
- Counters are shared across the subtree; child limits can tighten but never loosen
  ancestors' (`maxTurns` stays per agent). A `pipelineTool` call costs one call and
  one depth edge; depth `0` permits handler tools but rejects pipeline tools.
  Nested execution works with `maxConcurrency: 1`. The outer pipeline's DAG
  `maxConcurrency` is separate.
  Input waits also hold no leaf permit; reader errors still retain handler provenance.
- Delegate through registered pipeline tools; calling `run` from a handler is
  outside this contract.
- Cancellation and fatal failures stop new calls and drain active work without
  calling the reducer or starting another decision. Handlers must honor
  `context.signal`; an uncooperative promise cannot be terminated.
- Planning never initializes state or calls models or tools. A dry run skips the
  agent unless `dryRun(state, context)` supplies a preview decision source; tools
  skip unless they have a preview handler. A skipped required output fails
  finalization rather than inventing one.

## Stream public assistant text

Both adapters accept a `text(event, signal)` callback (`AgentTextEvent` and
`AgentTextSink` are exported from `tubeless/agent`). Without it, requests use JSON;
with it, decision requests stream over SSE and compaction stays private. Streaming
enables no transcript storage.

```ts
const model = anthropicModel({
  text(event) {
    if (event.kind === "delta") process.stderr.write(event.text);
    else process.stderr.write(event.status === "completed" ? "\n" : "\n[interrupted]\n");
  },
});
```

- Each HTTP attempt has a fresh `streamId`, provider name and agent `turn`. Ordered
  `delta` events carry public assistant text only; `end` carries `completed` or
  `interrupted`. Thinking, reasoning, tool arguments, finish results, compaction
  summaries and native conversation state never enter these events.
- Delivery awaits the sink within the decision deadline. Pass the supplied signal
  into async I/O; interruption notices may arrive already aborted.
- A successful `end` means the provider response completed, not that the result
  passed validation. Failed streams commit no conversation. After a successful HTTP
  response, streaming failures are not retried, so shown text is never silently
  replayed; discard partial text or keep it labelled as interrupted.
- The sink owns filtering. Filter live content before writing it, redact transcripts
  separately with `transcript.redact`, and sanitize terminal control characters
  yourself. Use `streamId` for state when sensitive values span deltas.

`tubeless agent --stream` streams commentary to stderr for built-in providers; the
validated answer keeps its usual stdout routing, and the flag does not enable
`--capture-transcript`. Forward the factory's `text` setting into a custom adapter.
Try the credential-free [scripted model demo](../examples/agent-transcript-model.ts):

```sh
bun run tubeless -- agent --model-module ./examples/agent-transcript-model.ts --stream --prompt "Demonstrate streaming"
```

## Opt-in transcripts

Set `transcript` on `defineAgent` or `defineAgentLoop` to observe content in a
provider-neutral format. Without it nothing is copied or delivered. Capture is
independent of tracing, `--trace`, `--store` and durable checkpoints, and the
application supplies the sink.

```ts
import { defineAgent, type AgentTranscriptRecord } from "tubeless/agent";
import { openaiModel } from "tubeless/agent/openai";

const records: AgentTranscriptRecord[] = [];
const agent = defineAgent({
  id: "inspectable-agent",
  model: openaiModel(),
  transcript: {
    write: (record) => {
      records.push(record);
    },
    // Suppress instructions and task text; apply your application's policy to other events.
    redact: (event) => (event.kind === "prompt" ? null : event),
  },
});
await agent.runOrThrow({ task: "List the files in this workspace." });
```

Each version-1 record has `agentId`, `runId` (joins structural history),
`parentRunId?`, `sequence`, `timestamp`, `turn` and `dryRun`, plus an `event`:

| Kind         | Content                                                                                 |
| ------------ | --------------------------------------------------------------------------------------- |
| `prompt`     | Task and assembled instructions for a decision (model-backed agents).                   |
| `assistant`  | One public text block from a bundled provider.                                          |
| `decision`   | Raw proposed decision before validation, including call arguments or finish data.       |
| `call`       | Call ID, tool name and validated input, including script-issued calls.                  |
| `outcome`    | Call ID, tool name, validated value or expected tool error; `replayed: true` if reused. |
| `compaction` | Provider name after successful compaction.                                              |
| `end`        | `completed`, `failed` or `cancelled`; `replayed: true` for checkpoint replay.           |

Capture excludes opaque conversation state, encrypted reasoning, thinking blocks and
raw HTTP bodies; it is not a replayable provider conversation. A recorded proposal
can still fail validation, and fatal error details stay in structural history.
Child agents need their own explicit `transcript`. Plans and skipped dry runs emit
nothing.

**Privacy and bounds.** Content can include project guidance, file contents, scripts
and tool errors. `redact` receives a frozen snapshot and returns a same-kind
replacement or `null` to suppress; an invalid replacement disables capture. Content
that is not finite plain JSON becomes an `{ omitted, reason }` marker.
`maxRecordBytes` (default and maximum 64 KiB) and `maxBytes` per invocation (default
1 MiB, maximum 16 MiB) bound output; oversized events become omission markers
without reaching the redactor, and after `{ limit: "maxBytes" }` capture stops. A
missing end event or omission does not establish an empty or failed conversation.

**Delivery** is awaited and serialized per invocation in observation order (tool
outcomes in completion order; match by call ID). A sink or redactor failure disables
that invocation's capture with a warning and does not change execution. You own sink
deadlines, permissions and retention; slow writes delay the run. Capture is
best-effort: process death can leave partial records.

The [credential-free recipe](../examples/agent-transcript.ts) shows an NDJSON
destination and decision suppression.

### Save and inspect a transcript

`openNdjsonAgentTranscriptWriter(path)` from `tubeless/agent/node` is a validated
NDJSON sink: pass `writer.write` to `transcript.write`, then await `writer.close()`
after every agent using it has settled. It appends (never truncates), creates files
with mode `0600`, and serializes simultaneous runs.

```ts
import { openNdjsonAgentTranscriptWriter } from "tubeless/agent/node";

const writer = await openNdjsonAgentTranscriptWriter(".tubeless/transcript.ndjson");
try {
  const agent = defineAgent({
    id: "recorded",
    model: openaiModel(),
    transcript: { write: writer.write },
  });
  await agent.runOrThrow({ task: "Inspect this workspace." });
} finally {
  await writer.close();
}
```

The writer records content only; enable tracing separately so history and Studio can
join records by run ID. Attach a finished transcript to its history:

```sh
tubeless history --store .tubeless/runs.sqlite --transcript .tubeless/transcript.ndjson <agent-run-id>
tubeless history --trace run.ndjson --transcript .tubeless/transcript.ndjson --json <agent-run-id>
tubeless ui --trace run.ndjson --transcript .tubeless/transcript.ndjson
```

History adds the run's content (`transcript` with records and recording status in
`--json`); Studio adds a **Transcript** tab with paginated records. Nested agents
keep their own transcripts: open the child run. The whole file is validated before
display (at most 64 MiB, 100,000 lines, 64 KiB per record); identical
`(runId, sequence)` records dedupe and conflicts are rejected. Recording status is
`complete`, `partial` (gaps or no end marker), `limited` (byte-limit marker) or
`unavailable` (no matching records, possibly fully suppressed), independent of the
agent's execution status. The file is a read-only snapshot; reopen to see appends.

To keep content with SQLite history, import the finished artifact:

```sh
tubeless history --store .tubeless/runs.sqlite --import-transcript .tubeless/transcript.ndjson
tubeless history --store .tubeless/runs.sqlite <agent-run-id>
```

Every transcript run must already exist in that store; import is all-or-nothing,
dedupes identical records, rejects conflicts, and leaves the source file unchanged.
History and Studio then read the saved content without `--transcript`. Content lives
in a separate table that inherits the database's filesystem permissions, so protect
the database and its sidecars. Clearing SQLite history deletes its transcripts in
the same transaction; clearing is disabled while Studio has a transcript artifact
attached.

`tubeless agent --store <path> --capture-transcript` captures directly with default
bounds and no redaction (full application content), and does not override a selected
agent's own sink. See [CLI recording](./cli.md#prompt-a-workspace-agent). On
Cloudflare, use `createCloudflareAgentTranscriptWriter` from
`tubeless/cloudflare/transcript` as each agent's sink; see
[Cloudflare capture](./deploy-cloudflare.md#opt-in-agent-transcripts) and its
[recipe](../examples/agent-transcript-cloudflare.ts).

## Inspection and recordings

Plans show the bounded turn pipeline, the agent's capability inventory and limits.
Definition identity covers capabilities, schema fingerprints, limits and tool
pipeline identities; set `implementationVersion` when changing prompts, validators,
reducers or handlers whose semantics the graph cannot show.

Execution uses ordinary `decide`, `calls` and `reduce` steps with a child run per
turn and per dispatched tool (`itemKey` is the call ID). Trace attributes record
`agent.runId`, `agent.turn`, `agent.callId`, `agent.tool` and bounded
decision/count/state-version summaries; state, prompts, inputs and outputs are not
recorded automatically.

`tubeless history <run-id>` shows an agent or a parent pipeline containing agents
as agent → turn → call → child agent, with decisions, state versions, call counts,
errors and termination (validated finish, limit exhaustion, cancellation, failure,
skipped execution, or completion without a recorded finish). A failed tool can
appear in a completed turn when the agent recovered.

```sh
bunx tubeless run --trace agent.ndjson ./examples/agent-delegation.ts -- --question "red missing"
bunx tubeless history --trace agent.ndjson <agent-run-id>
bunx tubeless history --trace agent.ndjson --json <agent-run-id>
```

`--json` adds `agentHistory.agents` with each agent's run ID, capabilities, limits,
termination and ordered turns with calls. Calls link to children through
`childAgentRunIds`, and each child's `parentCall` names its owner. A run with no
terminal event stays recorded as running, which does not prove a process is alive.
Older traces remain readable, with missing decisions or aliases shown as unknown.

## Durable execution

Add `durability` and an explicit `implementationVersion` to either factory. The
execution key identifies one task across restarts: invoke the same agent with the
same key and inputs to resume. Use a new key for new work or after changing the
definition, prompt, validators, reducers, model configuration or tools.

```ts
import { defineAgent } from "tubeless/agent";
import { openSqliteAgentCheckpointStore } from "tubeless/agent/node";
import { openaiModel } from "tubeless/agent/openai";

const store = await openSqliteAgentCheckpointStore(".tubeless/agents.sqlite");
try {
  const agent = defineAgent({
    id: "coding",
    implementationVersion: "coding-v1",
    model: openaiModel(),
    durability: { store, key: "issue-123" },
  });
  await agent.runOrThrow({ task: "Fix issue 123 and verify the change." });
} finally {
  store.close(); // after active invocations have settled
}
```

The SQLite store uses Node 22.18+ `node:sqlite` with no dependency, creates files
with mode `0600`, and rejects existing files with group or other access on POSIX
(on Windows, protect the directory with ACLs). It keeps a private
`<database>.leases` directory with one lock per execution key: different keys run
concurrently, a second owner of the same key is rejected, and locks release when the
process exits. Keep that directory while any store is open. It targets one host with
a local filesystem; use another store for other runtimes or distributed ownership.

The credential-free [durable workspace recipe](../examples/agent-durable.ts) derives
a key from the task, so repeating a task returns its saved answer without repeating
tools:

```sh
bun run build
node dist/workbench/workbench-bin.js run examples/agent-durable.ts -- --task "hello durable"
```

Resume is driven by the key, independently of the CLI's artifact `--resume` flag and
trace storage. A saved answer describes the committed execution and does not recheck
files that have since changed. Plans and dry runs open no storage. Root input
validation runs on every invocation.

Child agents share their parent's journal and ancestor budgets, including through
ordinary pipeline composition. Every live child joining recovery must declare its own
`implementationVersion` (previewed children need none); ancestor identities include
child versions, so changing a child invalidates saved ancestor results. Ordinary
pipelines are not checkpointed step by step, so keep fan-out keys stable and mapping
deterministic.

| Call state at restart       | Behavior                                                           |
| --------------------------- | ------------------------------------------------------------------ |
| Completed                   | Reuse the validated outcome; do not dispatch again.                |
| Pending                     | Dispatch after the saved batch admission.                          |
| Running, `replay: "safe"`   | Rerun with the same durable call identity.                         |
| Running, `replay: "unsafe"` | Return `TUBELESS_AGENT_CALL_INTERRUPTED` as a recoverable outcome. |

Handler tools and ordinary pipeline tools default to `"unsafe"`; read, list, search
and directly registered agent pipelines default to `"safe"`. Set `replay: "safe"`
only for repeatable work or operations protected by business idempotency. Custom
tools and decision callbacks receive `context.execution` (execution ID, agent
route, turn, optional call ID); use all applicable fields for external idempotency
keys, since trace run IDs change after restart.

**Checkpoints cannot make external effects exactly once.** An interrupted unsafe
mutation may have run partially or fully, so the agent must inspect its effects.
Unacknowledged decisions may trigger a new model request. Initialization,
validators, mappers and reducers must be pure because a crash can repeat them.
Cancellation preserves resumable state; ordinary fatal failures are saved as
terminal. A rejected storage write stops the invocation.

Implement `AgentCheckpointStore` for another backend: `acquire` must guarantee
exclusive ownership, and `write` must atomically replace the bytes and resolve only
after durable acknowledgement (trace exporters do not qualify).
`createMemoryAgentCheckpointStore()` suits tests; its data dies with the process.
The default `plainAgentCheckpointCodec` handles finite plain data; other validated
arguments or results need a deterministic lossless codec. Checkpoints contain task
inputs, prompts, conversation and outputs, so protect them as application data.

## Execution environments

The default local environment uses the host's filesystem and shell permissions.
Supply `environment` to either factory to place all default workspace tools and
project-guidance discovery in a different workspace:

```ts
import { defineAgent, type AgentEnvironment } from "tubeless/agent";
import { openaiModel } from "tubeless/agent/openai";

function agentForWorkspace(environment: AgentEnvironment) {
  return defineAgent({ id: "remote-coding", model: openaiModel(), environment });
}
```

An `AgentEnvironment` implements `resolveCwd`, `projectInstructions`, `read`,
`write`, `edit`, `bash`, `list` and `search` against your sandbox or remote service,
honoring the cancellation signal. It may be a capability object or an async factory
(resolved once per live invocation, never during planning or skipped dry runs).

- The backend enforces the [workspace tool limits](#default-workspace-tools): at most
  1 MiB for `write.content`, `edit.oldText` and `edit.newText` (oversized arguments
  fail validation before the batch starts), and results within the documented
  read, bash, list and search bounds. Oversized results fail validation; truncate in
  the backend and set `truncated`. File size and mutation semantics are also the
  backend's job.
- An explicit environment has no local filesystem or guidance fallback. Its stable
  `id` names the workspace authority and cwd the workspace within it; durable resume
  rejects changes to either.
- Custom tools and decision callbacks receive `context.environment`, and composed
  children inherit it unless they declare their own. Closures must use it rather than
  touching the host directly.
- If an operation rejects while the run's signal is aborted, the run keeps the
  cancellation reason even when the adapter throws an SDK-specific error.
- Environments supply capabilities, not a sandbox: isolation and remote-process
  termination belong to the backend.

`createNodeAgentEnvironment()` from `tubeless/agent/node` exposes the local adapter
explicitly. Its default `node:local` id names the local filesystem authority rather
than the host, so a recreated container still resumes its checkpoints; pass `{ id }`
to name a distinct authority. The credential-free
[environment recipe](../examples/agent-environment.ts) lists a workspace through an
explicit Node adapter.
