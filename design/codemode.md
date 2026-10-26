# Code mode for model agents

Status: first slice. `defineAgent({ codemode: true })`, `defineAgentLoop({ codemode: true })`
and `tubeless agent --codemode` replace the advertised tool list with one `codemode` tool.
Code mode is a setup-level permission, so autonomous pipeline agents use it only when their
definition opts in. With the flag, `AgentCall`, `AgentDecision` and `AgentOutcome` take a
`Codemode` parameter and name only `codemode`. Its script calls every registered
tool, including defaults, custom tools, pipeline tools and MCP tools, as a typed async function.

## Why

Large MCP inventories cost prompt space and turns. Each direct call needs a model round trip,
and every intermediate result passes through the context window. Code mode lets the model chain
dependent calls, loop and filter results inside one script, then return only what it needs.

Tubeless already models a tool call as a child pipeline under the turn's `calls` step. A
script becomes one visible call whose nested tool calls are ordinary child runs, so traces,
Studio and budgets show what the script did.

## Prior art

- Cloudflare `@cloudflare/codemode`: one tool with `{ code }`, generated
  `declare const codemode: { … }` types in the description, a fresh isolate per run, a JSON RPC
  bridge, and a `{ result, logs }` result. The default timeout is 60 s, with no network by default.
- pi `@earendil-works/pi-codemode`: a raw JavaScript async function body that calls
  `tools.<name>(args)` in a QuickJS sandbox, one worker thread per run on Node, with no timers,
  network, `process` or `require`. pi-durable makes scripts deterministic and replays a call log on
  restart.
- Anthropic programmatic tool calling: the code calls tools by pausing the container for each
  call. The docs say `allowed_callers` is not a security boundary.

## Contract

- **Model-facing tool.** `codemode` takes `{ code: string }`, a JavaScript async function body
  of up to 64 KiB. The description contains usage rules and generated declarations:
  `declare const tools: { read(input: { … }): Promise<{ … }>; "files__read-text"(…): … }`.
  Declarations come from each tool's input JSON Schema and, where available, the output schema's
  JSON Schema; otherwise the output is `unknown`. The model sees only `codemode` (plus a provider's
  finish function). Tools are reachable only from scripts.
- **Result.** `{ result, logs }`. `result` is the script's JSON-serialized return value (`null`
  for `undefined`), up to 16 KiB. `logs` holds up to 200 `console.*` lines and 4 KiB, and
  `logsTruncated` reports dropped lines.
- **Recoverable script failures.** These return `ToolError` observations: syntax errors,
  uncaught exceptions (`CODEMODE_SCRIPT_ERROR`, with logs appended), timeouts (`CODEMODE_TIMEOUT`,
  60 s), sandbox exhaustion and oversized results (`CODEMODE_RESULT_TOO_LARGE`).
- **Nested calls.** `tools.x(input)` validates input with the same preparation as a top-level
  call. Invalid input or a recoverable `ToolError` rejects inside the script with an `Error` that
  carries `code`. Fatal failures abort the script and fail the run, just like a direct call:
  handler exceptions, cancellation and limit exhaustion. Each nested call is charged against
  `maxCalls` and admitted through the shared leaf queue, so `maxConcurrency` applies. Calls still
  running when the script returns are drained before the result is published.
- **Visibility.** The script is logged on the `codemode` call, bounded to 16 KiB. Each nested call
  is a child run of that call (`itemKey` `<call>.<n>`) with its usual activity log.
- **Durability.** The script is a single checkpointed call. Its replay policy is `safe` only when
  every reachable tool is `safe`. Otherwise an interrupted script becomes the standard
  `TUBELESS_AGENT_CALL_INTERRUPTED` observation. Nested calls are not individually journaled.
- **Dry runs.** Scripts execute, and each script call follows its tool's dry-run policy.
  Read-only defaults run; tools without preview handlers skip, and awaiting a skipped result
  fails the preview, as a direct call would.

## Executors

`codemode-executor.ts` splits the sandbox in two. The platform-neutral harness owns the deadline,
cancellation, tool dispatch, draining of calls the script did not await, fatal and recoverable
failure classification, and JSON-only replies. A `CodemodeExecutor` only runs one script with a
JSON-text `call(name, input)` bridge, and stops when its signal aborts. The harness stops waiting
for an executor that ignores the signal and rejects its later calls with `CODEMODE_STOPPED`.
Executors share the in-sandbox setup in `codemode-realm.ts`, so `tools`, `console`, reply decoding
and log bounds behave the same everywhere.

- **Node or Bun (default):** `createNodeCodemodeExecutor()` starts one worker thread per script,
  with resource limits. Inside the worker, the script runs in a `node:vm` context. String code
  generation and WebAssembly are disabled, and there are no timers, `fetch`, `process` or
  `require`. Only JSON text crosses the realm boundary, so host-realm objects stay out of reach.
  The host terminates the worker on stop. Runtimes without file-based worker threads, such as
  Workers with `nodejs_compat`, fail when the executor is created, so the run fails with
  `TUBELESS_AGENT_CODEMODE_UNAVAILABLE` instead of every script failing recoverably.
- **Cloudflare:** `createWorkerLoaderCodemodeExecutor(env.LOADER)` loads a fresh Dynamic Worker
  per script with `globalOutbound: null`, no `env` and a CPU budget, and passes the bridge as an
  RPC function. workerd compiles all modules at load, so a syntax error fails the load; the
  executor maps that load failure to a script error with its line. A Dynamic Worker cannot be
  terminated from the host, so stops rely on the harness ignoring late calls and on the CPU
  budget. Miniflare does not enforce that budget. A Miniflare test runs a real agent with code mode
  inside workerd.

Neither is a security boundary in the strict sense, though a Dynamic Worker isolate is a much
stronger one than `node:vm`. The default `bash` tool already runs with host permissions.

## Deferred

- Remote sandbox executors (for example a container service) built on the same contract.
- Deterministic replay of nested calls from a call log, as in pi-durable and Cloudflare's
  `CodemodeRuntime`.
- Tool discovery (`search`/`describe`) for inventories whose declarations exceed the description
  budget.
