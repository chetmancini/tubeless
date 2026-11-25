---
name: tubeless
description: Author, modify, or review typed Tubeless pipelines, pipeline-backed CLI commands, and projects in TypeScript applications. Use for dependency modeling, failure and skip policies, dry runs, child pipelines, and pipeline tests. Library implementation and internal tests follow the repository's maintainer guidance.
---

# Author Tubeless pipelines

This skill guides applications built with Tubeless. Within the Tubeless
repository, use it for examples and pipeline definitions; library implementation
and internal tests follow the repository's maintainer guidance.

Use the project's installed Tubeless version and public package imports. Keep
domain logic in ordinary functions and make orchestration explicit in the graph.

## Find the documentation

Read the consumer's package manifest, installed Tubeless version, and existing
pipeline conventions first. The installed `tubeless` package ships `docs/` and
`examples/` (locate it through the project's package manager; in the Tubeless
repository they are at the root). Read `docs/agent-guide.md`, then the smallest
matching example in `docs/recipes.md`. These paths are relative to the Tubeless
package, not this skill. If package docs are absent, use the
[public index](https://tubeless.io/llms.txt),
[agent guide](https://tubeless.io/docs/agent-guide.md), and
[recipes](https://tubeless.io/docs/recipes.md). Check newer examples against the
installed declarations; do not silently upgrade Tubeless.

## Rules

Steps and results:

- One `createSteps<TDomainOptions>()` and one `definePipeline` per pipeline;
  destructure the constructors used (`step`, `waitForInput`, `fromPipeline`,
  `fromRemote`, `iteratePipeline`, `forEachPipeline`). Let generics infer;
  partial explicit generics widen the pipeline ID to `string`.
- Domain options hold business input. Built-in controls go separately:
  `run(options, controls?)`, `plan(controls)`, `run(undefined, controls)`.
- Stable kebab-case step IDs with operational descriptions. `name` is display only.
  Pass data through returned outputs, not shared mutable state.
- `dependsOn` for required output, `optionalDependsOn` when absence is valid,
  `skipAfterFailureOf` for a failure gate without data. Publication depends on
  successful validation.
- `skip` only for intentional successful omission; a string or `{ reason }` makes
  the output `T | undefined`. Never turn exceptions into skips.
- `{ id, steps }` runs every step and returns the last step's output.
  `finalize: step` returns one step's exact output; `requireOutputs` guards
  explicit finalizers. Never default a missing required output.
- Validate untrusted data with Standard Schema (`createSteps(optionsSchema)`,
  `outputSchema`, `resultSchema`); core needs no schema dependency.

Dry runs and side effects:

- Set `dryRun: "skip"` on writes, mutations, publication, and email, or supply a
  side-effect-free typed `dryRun` handler. Unmarked steps still run. Dry run is not
  rollback.

Selection:

- Declare public goals with `targets: [step]`; runs select them and get their
  prerequisites. `stepIds` is exact filtering and cannot be combined with `targets`.
  The CLI flags are `--step` and `--target`; `mapOptions` and hooks receive
  `stepIds` and `targets`. `plan()` previews selection without invoking schemas.

Running and errors:

- `runOrThrow` for a value-or-throw caller; `run` to inspect failures, skips, and
  partial output (branch on `run.finalized` before `run.value`).
- Branch on `PipelineError.code`, `phase`, and `kind`, never message text.
- Inside steps use `context.log`, forward `context.signal`, use `context.sleep`,
  report progress for long loops, and resolve paths from `context.cwd`.

Concurrency and caching:

- `run(options, { maxConcurrency: n })` enables parallel independent steps
  (default `1`); child and fan-out runs have separate limits.
- `cache: { version: "v1" }` on deterministic steps; `{ cache: "recompute" }`
  refreshes. The default codec rejects lossy round trips (class instances).
  See `docs/step-output-cache.md` and `examples/step-output-cache.ts`.

Projects and CLI:

- Group pipelines with `defineProject(id, [pipelineA, commandB])` from
  `tubeless/project`; register each pipeline exactly once, directly or through its
  `definePipelineCommand` entry. Retrieve with `project.get(id)`. Default-export the
  project to select it for the CLI and Studio.
- `tubeless init` starts a project; do not hand-write the first file. Use
  `pipelines/<name>.ts` for definitions and `scripts/<name>.ts` command wrappers
  only when explicit `params`, `mapOptions`, or presentation are needed.
- Schema-backed pipelines get inferred CLI flags from Standard JSON Schema input
  metadata (`examples/automatic-cli.ts`). Schema-less pipelines need an explicit
  `definePipelineCommand` with `params`. Do not parse `process.argv` or redeclare
  built-in flags. Application flags follow `--`: `tubeless run <id|file> -- ...`;
  `run --json` prints the report on stdout.
- `--resume` exists only with managed `checkpoint` configuration or an explicit
  `resume: true` command that handles `values.resume`.

Composition:

- `fromPipeline` for an independently useful child; `forEachPipeline` for runtime
  fan-out with stable keys (`onItemFailure: "stop" | "collect"`); `iteratePipeline`
  for bounded repetition with `maxIterations`. Child `targets`, `stepIds`, and
  concurrency go in `controls`, never `mapOptions`.
  See `docs/child-pipeline-composition.md`.
- `fromRemote` needs `adapter`, `mapInput`, `outputSchema`; the adapter must honor
  `context.dryRun` and the signal. `createWorkerThreadAdapter` (`tubeless/node`)
  gives CPU parallelism. See `docs/remote-step-composition.md`.
- Use `runConcurrent`/`runConcurrentPartial` (`tubeless/batch`) for lightweight
  bounded work without child lifecycle reporting.

Declarative documents:

- Parse YAML/JSON at the application edge, then
  `compilePipelineDocument(document, registry)` from `tubeless/project` with
  explicitly registered handlers, adapters, predicates, and schemas; use
  `compiled.get(id)` or `defineProject`. Validate structure with
  `tubeless validate --json`. See `docs/declarative-pipelines.md` and
  `examples/yaml-pipelines.ts`.

Agents:

- `defineAgent({ id, model })` from `tubeless/agent` with `openaiModel()`,
  `anthropicModel()`, or `aiSdkModel()` from `tubeless/agent/ai-sdk`. Install the
  optional `ai` peer (v7 or later) for the AI SDK adapter. Typed in-pipeline agents
  add `inputSchema`, `task`, and
  `resultSchema` and compose through `fromPipeline` (`examples/agent-extract.ts`).
  `defineAgentLoop` is for custom `decide` callbacks. Restrict tools with
  `defaultTools`, validate every tool boundary, keep credentials and provider calls
  in application code, and opt in explicitly to `transcript` capture and code mode.
  See `docs/agents.md` and `examples/agent-*.ts`.

Optional capabilities:

- Output capture: a run's `outputObserver: { encode, write }` receives raw values
  before schema transformation and writes detached bytes after validation, before
  dependents start. Supply a lossless codec and owned persistence; dry runs bypass
  capture and children never inherit it. See `docs/step-output-observation.md`.
  Supply compatible decoded raw values with `suppliedOutputs`, a map of selected
  step IDs to unknown values. Output schemas still validate; handlers/cache are
  bypassed and supplies are not observed again. Exact `stepIds` must include
  supplied intermediates and their consumers to omit upstream work. The host
  checks business execution, implementation, input, and codec identity before reuse.
  Recovery controls belong only on direct invocations, not authored child controls.
  Adapt `examples/step-output-recovery.ts` and its application-owned file adapter
  for fresh-host recovery; read `docs/step-output-recovery.md`. Reconcile effects
  without saved outputs using business idempotency keys. Bundled engine examples
  retain whole-attempt retries until their host adapter explicitly adds recovery.
- For host-owned crash recovery, supply `executionJournal` in runtime context.
  Require explicit pipeline implementation versions and stable inputs/controls;
  acknowledged outputs restore, while incomplete ordinary effects stop for
  reconciliation. Keep mappers, predicates, schemas and finalizers replay-safe.
  Hosts own storage, fencing and waiting; input requests use stable
  `executionJournalPath`, while each invocation has a fresh `runId`. Native agents
  use inherited/explicit checkpoints or the host's `agentStore` and suppress the
  outer journal inside agent work. This is separate from item checkpoints and
  caches. Read the package's `docs/execution-journal.md` and adapt
  `examples/host-embedding.ts`.
  Do not combine a live journal with nonempty `suppliedOutputs`.
- Artifacts: `context.recordArtifact`, `loadArtifact`, `saveArtifact`
  (`docs/artifacts.md`). Graph metadata (`docs/graph-metadata.md`). Node helpers
  from `tubeless/node` (`definePaths`, `writeJson`, `resetDir`; mark writes
  `dryRun: "skip"`). Trace exporters are implemented in the application against
  `PipelineTraceExporter` (`examples/tracing.ts`). Keep storage and Studio optional
  (`docs/studio.md`).
- Hosted remotes: use `tubeless remote connect` or `tubeless remote create` for
  Tubeless Cloud or self-hosted Cloudflare, then target a saved profile with
  `--remote`. For manual Cloudflare setup use `tubeless init cloudflare` and
  `docs/deploy-cloudflare.md`;
  use `tubeless remote runner` with a separate Bun project for pipelines placed
  on a local runner. Allowlist Worker children in `localRunner.workerChildren`
  for explicit `fromPipeline` calls from a Bun root. See the runner placement
  recipe for matched definitions. Set `recoverInterruptedRuns` for versioned
  Worker and Bun roots that should restore acknowledged outputs after a restart. Runs are limited to 14 minutes
  and secrets stay out of config text bindings.
  Set `deploymentId` for trusted `app.launch` and `tubeless remote run` submissions.
  Follow or request cancellation by the execution ID.
- Host engines (Airflow, Temporal, Inngest, Dagster, Step Functions): read the
  matching package guide before integrating.

## Verify

Typecheck the consumer and run focused tests. Use `createPipelineTestRuntime`
from `tubeless/testing` with fake I/O, and `overrideStep(step, value)` with
`{ overrides }` to supply intermediate outputs (select overridden steps with exact
`stepIds`; see `examples/step-output-overrides.ts`). Check failure gates, skipped
outputs, and dry-run behavior. Generate diagrams with `pipeline.toMermaid()` when
useful.

Within the Tubeless source repository, also follow its `AGENTS.md` and run
`make check`.
