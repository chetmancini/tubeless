# Codebase untangling decision log

Scope: the complete repository, including the runtime, agents, CLI, hosting,
storage, Studio, examples, build/release scripts and website. Comments and tests
are included at the user's request. Source changes start only after this initial
inventory. Intended public behavior and package entrypoints stay stable.

## Starting evidence

- Clean worktree at `9e71d3f`.
- Read `AGENTS.md`, `docs/agent-guide.md` and `src/README.md`.
- Four independent read-only audits cover core/project/tracing/utilities/Node,
  agents, hosting/Cloudflare/storage, and workbench/CLI/reporters. The primary
  audit covers Studio, rendering, testing helpers, scripts, examples and website.
- Baseline `make check` passes: 272 test files, 3,880 passing tests and three
  platform-dependent skips. Build, typecheck, lint, Knip, formatting, docs, API,
  Studio generation and package verification pass. Lint reports two warnings:
  an unused CLI type import and an example's `finally` control flow.
- Existing emitted-runtime graph tests enforce acyclicity, optional integrations
  and narrow dependency direction. Keep these boundaries, with a more accurate
  graph reader.

## Decisions and problems they solve

### Give run-control copying one owner

- Hidden link: `src/core/pipeline.ts` and `src/core/child-execution.ts` each
  enumerate the same execution controls and copy selection arrays. A new control
  can silently differ between direct and nested runs.
- `src/core/pipeline-step-builders.ts` independently captures static iteration
  controls. Reuse the snapshot where validation and array ownership agree.
- Keep child-specific dry-run/cache inheritance at the child boundary.

### Own stable execution vocabulary once

- Hidden link: `src/core/pipeline-cache.ts`, `pipeline-plan.ts`, CLI parameter
  definitions, trace schemas and agent checkpoint restoration independently list
  the same three cache policies. Share the pure vocabulary while retaining
  boundary-specific errors and the separate `dynamic` metadata marker.
- Hidden link: `src/tracing/agent-transcript.ts` repeats event-schema names in its
  omission-kind enum. Derive the latter from the event registry.
- Hidden link: `src/node/worker-thread-adapter.ts` repeats the native timer ceiling
  already owned by `src/utilities/abort.ts`.
- Surplus: `src/core/lifecycle.ts` exposes a trace-suppression argument no caller
  uses. Remove it; every status notification still emits its trace.

### Put agent telemetry at the writer/reader contract boundary

- Hidden links: `src/agent/provider-usage.ts`, `turn.ts`, `codemode.ts` and
  `src/run-store/agent-projection.ts` independently spell model counters,
  lifecycle attributes and turn step IDs. Storage schemas and history merging
  depend on the same vocabulary.
- Add a pure tracing-owned contract used by producers and consumers. Execution
  must not import storage, and history must not import agent execution.
- Needless link: `ToolError` lives beside capability compilation in
  `src/agent/tools.ts`, so filesystem, shell and error-classification code imports
  a compiler to obtain an error class. Give the error a small independent owner
  and preserve its public export and identity.

### Separate hosted batching from transport delivery policy

- Needless link: `src/hosting/run.ts` combines ordered batching with trusted RPC
  retry policy. `collector-run.ts` disables that policy with zero-valued retry
  options because collector transport already owns exact-byte retries.
- Move sequence/count/delay/drain ownership to a shared batching module. Trusted
  delivery owns its existing five attempts and exponential backoff; collector
  delivery keeps its own policy. Preserve one failure notification and ordered
  shutdown, including delivery after execution cancellation.

### Consolidate persistence and collector wire rules

- Hidden link: `src/run-store/run-store-sqlite.ts` duplicates transaction
  begin/commit/rollback logic already owned by `sqliteTransaction`.
- Hidden link: `src/run-store/agent-transcript-sql.ts` hardcodes the record byte
  limit owned by the transcript contract. Interpolate that constant into the
  unchanged SQL constraint.
- Hidden links: attempt identities and collector token grammar are repeated in
  `attempt-store.ts`, `attempt-batch.ts`, `collector-protocol.ts`, credentials,
  HTTP, transport and SQLite authority lookup. Share grammar and parsing; keep
  authentication, expiry, transaction fences and authorization with their owners.
- Needless link: collector HTTP imports generic JSON response construction from
  Studio. Use a neutral response helper; Studio keeps its error vocabulary,
  request guards and formatting policy.

### Reuse Cloud CLI body ownership and CLI execution paths

- Hidden link: `src/workbench/cloud/client.ts` duplicates the bounded cancellable
  stream reader in `src/utilities/read-body.ts`. Reuse byte reading while keeping
  Cloud's content-type, declared-size, UTF-8, JSON and empty-body diagnostics.
- Hidden links: `src/workbench/agent/command.ts` duplicates agent limits,
  validation minima and tool names; `workbench-command-specs.ts` repeats defaults
  in help. Derive CLI configuration from existing owners without eagerly loading
  optional agent execution into unrelated commands.
- Hidden link: selected-agent override rejection maintains a second inventory of
  builtin-only flags. Group those definitions and derive rejection keys.
- Surplus: `src/cli/cli-command.ts` repeats checkpoint attachment/execution/
  finalization in `main` and `executeValues`. Delegate through the existing path
  and remove its unused `CheckpointStore` import.

### Give Studio replies one decoding convention

- Hidden link: `src/studio/browser/transport.ts` manually defines and validates
  capabilities, launch/cancel and history-clear replies, while the remaining
  protocol uses `src/studio/shared/schema.ts`. Put successful reply shapes in
  the schema owner and derive their types.
- Repeated request-status and decode failure handling obscures endpoint policy.
  Keep access retirement, conditional snapshots, missing-run semantics, request
  guards and run/cursor identity checks explicit; share success/error decoding.
- Hidden link: transcript cursor validation in `src/studio/server/api.ts` repeats
  the existing nonnegative query-integer parser. Use that parser.
- Keep independent resource lifecycles: snapshot selection, run-detail revision
  coalescing, definition refresh and transcript pagination have different owners
  and refresh requirements. No general resource framework is needed.

### Make architecture checks inspect JavaScript syntax

- Hidden link/special case: the regex import reader in
  `src/core/pipeline-entry.test.ts` treats scaffold template text as dependencies.
  `src/workbench/workbench-init-project.ts` interpolates a constant solely to hide
  an ordinary generated import from that test.
- Parse emitted JavaScript with the installed TypeScript 5.4 compiler API.
  Include static imports, re-exports and literal lazy imports, including imports
  inside template substitutions; ignore comments, ordinary strings and raw
  template text. Then remove the scaffold workaround.
- Surplus: the graph test's Node cache-export exception is unreachable because
  Node already permits utilities.
- Brittle tests: exact visited-file counts require incidental imports instead of
  only enforcing allowed boundaries. Replace these assertions during final test
  cleanup; add scanner behavior cases that protect edge discovery.

### Clean comments and tests after structural validation

- Remove comments that narrate implementation in the audited areas. Keep public
  contracts, external protocol/OS constraints and non-obvious safety invariants.
- Brittle test: `src/agent/codemode.test.ts` searches implementation text for
  `env: {}`. Exercise native worker environment isolation with a subprocess and
  sentinel secret instead.
- Timing assumptions: `src/reporter/live-ticker.test.ts` sleeps for startup and
  `workbench-run-integration.test.ts` sleeps before aborting a trace write. Wait
  for the behavior each test claims to exercise.
- No vacuous test batches were found. Keep type-inference probes, platform fakes,
  schema validation tests and behavior-based examples.

## Special cases retained as requirements

- Opaque child-pipeline invocation, inherited dry-run/checkpoint isolation,
  failure-isolated hooks/exporters, cancellation draining and worker grace periods
  preserve execution contracts.
- Provider compaction/schema/reminder rules, bounded HTTP retries, MCP session
  renewal, VM JSON bridging and worker source/build selection reflect external
  protocol/runtime requirements.
- Transcript redaction/sink failure isolation preserves run outcomes and prevents
  private content from entering diagnostics.
- SQLite driver/read-only/sidecar differences, legacy event decoding, Durable
  Object deadlines and watchdog handling, atomic admission/authority/replay checks,
  persisted cancellation intent and defensive history reconstruction remain.
- Terminal takeover/fallback, Cloud device authorization polling and admission
  idempotency, credential error redaction, and filesystem destination collision
  checks remain.
- Test skips depend on unavailable shells, platform facilities or Windows IPC;
  none suppress a known failing behavior.
- Website navigation/docs rewriting, immutable historical evaluation fixtures,
  platform integration examples and release guards have independent purposes;
  the initial audit found no worthwhile structural replacement there. Follow-up
  findings below cover the source-reference readers and animation timing.

## Validation and closure

All listed fixes are implemented. Structural changes were validated before test
cleanup. Tests now observe worker isolation, terminal readiness and progress
filtering directly; persisted iteration identities have fixed compatibility
fixtures captured from the prior runtime. No meaningful test batch was removed.
Implementation narration was removed across the audited modules. Public summaries
that merely repeated symbol names were replaced with useful contract descriptions
where the checked API documentation requires them.

- Final `make check`: all nine checks pass; 274 test files, 3,903 passing tests and
  three platform-dependent skips. Package verification passes with TypeScript
  7.0.2 and the supported TypeScript 5.4.5 floor.
- Final `make website-build`: passes; 21 tests, built-link validation and agent
  documentation checks pass across 22 Markdown documents and 31 sitemap pages.
- `bun run api:generate` regenerated checked artifacts. Exported symbol
  inventories remain unchanged across all 17 public entrypoints; declaration
  hashes and source links reflect internal ownership changes.
- The emitted runtime graph has 315 modules and 804 edges, with no cycles.
  Existing optional-integration and dependency-direction checks pass. Computed
  imports are limited to the five explicit module-loader owners.
- Independent cross-area reviews closed the initial and follow-up findings with
  no remaining structural issue worth fixing. Retained special cases above encode
  current protocol, persistence, platform and cancellation requirements.
- One pre-existing lint warning remains in `examples/agent-transcript-model.ts`
  (`no-unsafe-finally`); it does not fail the quality gate. The unused CLI import
  warning from the baseline was removed.
- Browser preview was attempted but the browser host was unavailable. Website
  compilation and automated validation passed; live visual inspection was not
  available. The temporary development server was stopped.
- Before pushing to `main`, rebased onto `026985b` (waiting Cloud run support).
  Integration validation passes: all nine package checks, 3,922 tests with three
  platform-dependent skips, and the website build with 21 tests.

## Independent follow-up findings

- The syntax-aware runtime graph scan also removes equivalent import-hiding
  workarounds in `workbench-init-cloudflare.ts` and
  `cloudflare/cloudflare-codemode.ts`; their generated source remains identical.
- `scripts/generate-api-reference.mjs` has the same false-edge problem in its
  separate declaration dependency regex. An independent audit reproduced a
  string-literal type containing `import("./unrelated.js")` pulling an unrelated
  declaration into the API hash. Use the installed compiler's declaration
  preprocessing to discover references, including genuine import types. Keep
  declaration whitespace/literal normalization: it serves a different hash
  stability requirement.
- The browser bundle's import regex in `scripts/generate-studio-client.mjs`
  likewise rejects import-like strings and misses external re-exports. Share a
  small compiler-backed module-reference reader with the architecture check and
  declaration collector. Return unresolved computed imports explicitly: the
  graph cannot follow them, but an inline bundle must reject them.
- `website/src/components/PipelineFlow.astro` independently spells pulse lengths,
  cycle distance and duration in CSS/keyframes and arrival-time JavaScript.
  Keep the motion values in the component's setup and expose them as CSS custom
  properties; compute arrival from those same properties.
- `src/agent/provider-http.ts` documents that the compaction threshold reserves
  room for the next tool-result batch, but `provider-tool-outputs.ts` owns that
  batch bound independently. A pure provider budget owner should derive the
  threshold from the existing request and batch limits without making result
  formatting depend on HTTP.
- The same provider HTTP module separately owns chunk arrays, byte counting and
  body cancellation already handled by `utilities/read-body.ts`. Reuse bounded
  byte reading and retain provider-specific retryable read failures, abort causes,
  size diagnostics and non-retryable JSON parse failures at the provider boundary.
- Computed imports are visible to the new syntax reader but cannot be followed
  by a static graph. Require their explicit ownership in the graph check, limited
  to application module loaders, worker execution and SQLite driver selection;
  a computed import must not silently bypass protected runtime boundaries.
- `core/pipeline-definition-identity.ts` also repeats the run-control whitelist
  for static iteration identities. Reuse the common snapshot and sort only the
  selector sets. Preserve its established property order and existing identity
  hashes; this is a persistence compatibility requirement, not a new hash format.
- Keep the FIFO pending-open test's bounded scheduling yield: the OS exposes no
  pending-open acknowledgement, and connecting a reader would remove the
  condition under test. The separate backpressure test can and should wait for
  observable queued output before aborting.
