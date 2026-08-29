---
name: tubeless
description: Use when generating, modifying, or reviewing tubeless pipelines, pipeline-backed CLI commands, studio catalogs, or agent evaluation submissions in this repository.
---

# Author tubeless pipelines

Copy layout and IDs from the project catalog. Choose primitives from the recipe
index. Follow the agent guide. Do not invent a second copy of those rules.

## Workflow

1. Open [examples/catalog/](../../examples/catalog/tubeless.studio.ts). Reuse
   its file names, export names, and kebab-case IDs.
2. Open the smallest matching row in [docs/recipes.md](../../docs/recipes.md).
3. Follow [docs/agent-guide.md](../../docs/agent-guide.md) for primitive
   selection, runtime, and safety rules.
4. Typecheck the consumer, then run focused tests.
5. After package or learning-surface changes, run `make check` from the package
   root.

## Catalog

A consumer project uses this shape:

- `pipelines/<name>.ts` — `createSteps` plus `definePipeline`; export `XPipeline`
- `scripts/<name>.ts` — `definePipelineCommand`; export `XCommand`
- `tubeless.studio.ts` — `definePipelineStudio` with those command modules

IDs are kebab-case and stable. Add `name` only when printed output needs a
friendlier label. Register studio commands explicitly; do not infer executables
from run history.

Read [docs/studio.md](../../docs/studio.md) before changing `tubeless ui` or
`definePipelineStudio`.

## Evaluation submissions

Write into a disposable directory that contains `solution.ts`. Compile with
`bun run eval:agent --`. Do not execute model-written submissions in this
repository.
