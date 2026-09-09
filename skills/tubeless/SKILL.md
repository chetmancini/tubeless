---
name: tubeless
description: Use when generating, modifying, or reviewing tubeless pipelines, pipeline-backed CLI commands, project manifests, studio catalogs, or agent evaluation submissions in this repository.
---

# Author tubeless pipelines

Copy layout and IDs from the project manifest. Choose primitives from the recipe
index. Follow the agent guide. Do not invent a second copy of those rules.

## Workflow

1. Open [examples/catalog/](../../examples/catalog/tubeless.project.ts). Reuse
   its file names, export names, and kebab-case IDs.
2. Open the smallest matching row in [docs/recipes.md](../../docs/recipes.md).
3. Follow [docs/agent-guide.md](../../docs/agent-guide.md) for primitive
   selection, runtime, and safety rules.
4. Typecheck the consumer, then run focused tests.
5. After package or learning-surface changes, run `make check` from the package
   root.

Use `composeTraceExporters` when one run needs multiple trace destinations.
Open finished CI or support traces with `tubeless history --trace` or `tubeless
ui --trace`; the NDJSON adapter is read-only, bounded, and does not redact
sensitive event contents.

## Catalog

A consumer project uses this shape:

- `pipelines/<name>.ts` — `createSteps` plus `definePipeline`; export `XPipeline`
- `scripts/<name>.ts` — `definePipelineCommand`; export `XCommand`
- `tubeless.project.ts` — `definePipelineProject` with stable IDs for those command modules

IDs are kebab-case and stable. Add `name` only when printed output needs a
friendlier label. Register project commands explicitly; do not infer
executables from run history or the filesystem. Use `tubeless list` before
addressing a command by its registered ID.

Read [docs/studio.md](../../docs/studio.md) before changing `tubeless ui` or
project/studio manifest behavior.

## Evaluation submissions

Write into a disposable directory that contains `solution.ts`. Compile with
`bun run eval:agent --`. Do not execute model-written submissions in this
repository.
