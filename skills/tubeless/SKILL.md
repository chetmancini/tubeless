---
name: tubeless
description: Author, modify, or review typed Tubeless pipelines, pipeline-backed CLI commands, and project catalogs in TypeScript projects. Use for dependency modeling, failure and skip policies, dry runs, child pipelines, and pipeline tests.
---

# Author Tubeless pipelines

Use the project's installed Tubeless version and public package imports. Keep
domain logic in ordinary functions and make orchestration explicit in the graph.

## Find the matching documentation

Read the consumer's package manifest, installed Tubeless version, and existing
pipeline conventions first. The installed `tubeless` package includes `docs/`
and `examples/`; locate it through the project's package manager. Within the
Tubeless source repository, use those directories at the repository root.

Read `docs/agent-guide.md`, then the smallest matching example in
`docs/recipes.md`. These paths are relative to the **Tubeless package**, not
this installed skill or the consumer's repository. If package docs are absent,
start with the [public documentation index](https://tubeless.io/llms.txt),
[agent guide](https://tubeless.io/docs/agent-guide.md), and
[recipes](https://tubeless.io/docs/recipes.md). Confirm newer examples against
the installed declarations before using them; do not silently upgrade Tubeless.

## Authoring decisions

- Use `createSteps<TDomainOptions>()` per pipeline and take its `step`
  constructor. Domain options contain business inputs; pass built-in controls
  separately to `run(options, controls?)`.
- Give steps stable kebab-case IDs and descriptions of their domain work.
  `name` is an optional display label. Return values from steps and consume
  inferred dependency outputs instead of sharing mutable state.
- Use `dependsOn` for required outputs, `optionalDependsOn` for expected
  absence, and `skipAfterFailureOf` for a failure gate without a required value.
  Keep publication dependent on successful validation.
- Add `skip` to a step definition for an intentional successful omission. Handle
  its `T | undefined` output explicitly; do not turn exceptions into skips.
- Set `dryRun: "skip"` on writes and other external side effects, or supply a
  side-effect-free typed preview handler. Unmarked steps still run in dry runs.
- Use `requireOutputs` when the final result requires specific outputs. A plain
  finalizer is appropriate when partial results are valid domain results.
- Use `runOrThrow` for callers expecting a successful value, `run` for callers
  inspecting structured failures or partial results, and `plan(controls)` when
  no work should execute. Plans do not validate domain input.
- Use `context.log`, forward `context.signal`, use `context.sleep` for waits,
  and report progress for long loops. Resolve relative paths from `context.cwd`.
- Branch on structured error `code`, `phase`, and `kind`, not message text.

## Add only the capabilities the workflow needs

Read the corresponding package recipe before using these features:

- For YAML or JSON authoring, read `docs/declarative-pipelines.md` and
  `examples/yaml-pipelines.ts`. Use `compilePipelineDocument` from
  `tubeless/project` on parsed data with explicitly registered handlers and
  schemas. Keep parsing at the application edge and command registration
  explicit. Handler inputs and pipeline results are unknown; validate or narrow
  them. Plans still do not validate business inputs.
  Use `tubeless validate --json <document.yaml>` for a structure-only check
  without handlers. Fetch `https://tubeless.io/schemas/pipeline-document-v1.schema.json`
  for editor and agent validation, or use packaged `docs/pipeline-document.schema.json`.
  Optional metadata (`name`, `description`, `authors`, `date`) does not affect
  execution; compile and plan to check handler references and graph semantics.

- `fromPipeline` for an independently useful child workflow;
  `forEachPipeline` for runtime fan-out with stable keys and bounded concurrency.
  Use ordinary helpers or `runConcurrent` for lightweight work without child
  lifecycle reporting.
- `createSteps(optionsSchema)`, `outputSchema`, or `resultSchema` for runtime
  validation at untrusted boundaries. Reuse the project's Standard Schema
  implementation; core needs no schema dependency.
- `definePipelineCommand` from `tubeless/cli` for pipeline-backed scripts.
  Built-in `--step` / `--target` flags map to `stepIds` / `targets`. Do not
  redeclare built-in flags. Read `docs/cli.md` for option mapping.
  Use `defineCommand` from `tubeless/cli` for standalone scripts and
  `definePipelineProject` from `tubeless/project` for project catalogs shared
  by the CLI and optional Studio.
- Use `pipelines/<name>.ts` for definitions and `scripts/<name>.ts` for command
  wrappers when introducing a layout. Register commands explicitly in
  `tubeless.project.ts`; adapt the package's `examples/catalog/` without copying
  unrelated example IDs. Preserve existing consumer conventions.
- Keep storage and Studio optional. Read `docs/studio.md` before adding them;
  read the composition guides before adding child or remote execution.
- Use `tubeless/node` for cwd-relative path factories, JSON artifacts, required
  environment values and checkpoints. Call `definePaths` factories with
  `context.cwd`; keep `writeJson` and `resetDir` inside dry-run-safe steps.
  `readJson<T>` parses but does not validate untrusted data. See `docs/recipes.md`.
- Implement concrete JSON or telemetry adapters in the application against
  `PipelineTraceExporter`; adapt the package's `examples/tracing.ts`. Use
  `composeTraceExporters` for multiple trace destinations. Finished traces
  can be read with `tubeless history --trace` or `tubeless ui --trace`; recorded
  contents are not redacted.

## Verify

Typecheck the consumer and run focused tests. Use `createPipelineTestRuntime`
from `tubeless/testing` for deterministic observation and cancellation, with
fake I/O for side effects. Check failure gates, skipped outputs, and dry-run
behavior. Generate diagrams with `pipeline.toMermaid()` when useful.

Within the Tubeless source repository, also follow its `AGENTS.md` and run
`make check`. For repository evaluations, write `solution.ts` in a disposable
directory and compile with `bun run eval:agent --`; do not execute model-written
submissions in the repository. Follow `docs/agent-evaluations.md` for assessment.
