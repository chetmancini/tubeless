# Getting started

This guide builds a small pipeline that loads, normalizes, and returns a list of
rows, then runs, previews, and tests it.

## Install

Install the package in your TypeScript project. Library imports require Node.js 22.18 or later:

```sh
npm install tubeless
```

`pnpm add tubeless`, `yarn add tubeless`, and `bun add tubeless` work too. The
README quick start is a complete first program.

Add `tubeless/cli` for terminal commands and `tubeless/project` for pipeline
projects; neither loads storage or Studio. The executable requires Bun 1.3.14 or
later:

```sh
bunx tubeless --help
```

Command-by-command usage is in [the CLI](./cli.md).

## Runtime support

Library imports (`tubeless` and every subpath) are ESM-only, dependency-free
compiled JavaScript, and require Node.js 22.18 or later.

Type declarations are verified with TypeScript 5.4 or later, under `NodeNext`
and `Bundler` module resolution. Projects that type-check declarations
(`skipLibCheck: false`) without `@types/node` need `ESNext.Disposable` in `lib`
for `tubeless/agent/mcp`.

The executable starts a small Node.js launcher that hands off to Bun, so Bun must
be on `PATH` even when npm or `npx` installs the package. On a machine with Bun
but no Node.js, run the CLI through `bunx` or `bun run`; `bunx --bun tubeless`
skips the Node.js start.

Linux and macOS are supported; Windows is untested.

## Try the CLI

From a Tubeless checkout, list and run a pipeline directly from a project:

```sh
bunx tubeless list --project examples/tubeless.project.ts
bunx tubeless inspect --project examples/tubeless.project.ts validated-import
bunx tubeless run --project examples/tubeless.project.ts validated-import -- --source rows.txt
```

The project contains only pipelines; the CLI derives `--source` from the
pipeline's input schema, with no command wrapper.

In your app, run `bunx tubeless init` to write a starter `tubeless.project.ts`
and `pipelines/import.ts`, or export `defineProject("my-app", [MyPipeline])` from
`tubeless.project.ts` yourself, then run `bunx tubeless list`. Pipelines whose
options schema exposes Standard JSON Schema metadata get flags automatically;
register commands in the list for custom inputs or presentation. See
[`examples/automatic-cli.ts`](../examples/automatic-cli.ts),
[`examples/project/tubeless.project.ts`](../examples/project/tubeless.project.ts),
and [the CLI](./cli.md).

## 1. Define domain options

Start with the data your pipeline needs. Execution controls such as dry-run mode
and step selection are passed separately from this input.

```ts
interface ImportOptions {
  lines: readonly string[];
}

const lines = ["  First row  ", "", "Second row"];
```

## 2. Create typed steps

Call `createSteps` once and take its `step` constructor. `normalize` declares
`dependsOn: [load]`, so it receives `load`'s output as a typed input
(`rows` is `readonly string[]`).

```ts
import { createSteps } from "tubeless";

const { step } = createSteps<ImportOptions>();

const load = step("load", {
  description: "Read source rows",
  run: (_inputs, context) => context.options.lines,
});

const normalize = step("normalize", {
  dependsOn: [load],
  description: "Normalize non-empty rows",
  run: ({ load: rows }) => rows.map((row) => row.trim().toLowerCase()).filter(Boolean),
});
```

Keep IDs stable: plans, reports, hooks, tracing, and CLI selection all use them.

## 3. Define the result

A single-goal pipeline needs only its ID and steps:

```ts
import { definePipeline } from "tubeless";

const ImportPipeline = definePipeline({
  id: "import",
  steps: [load, normalize],
});
```

Running without selection controls runs every step. Omitted `targets` exposes the
last step in execution order (`normalize`) as a public goal; selecting it also
selects `load`. Omitted `finalize` returns that step's output, typed
`readonly string[] | undefined` because a dry run or filter can leave it absent.

To expose other goals, use `targets` (or `targets: []` for none). To transform or
require outputs, use `finalize`:

```ts
import { requireOutputs } from "tubeless";

const SummaryPipeline = definePipeline({
  id: "import-summary",
  steps: [load, normalize],
  finalize: requireOutputs([normalize], ({ normalize }) => ({
    count: normalize.length,
    rows: normalize,
  })),
});
```

`requireOutputs` makes those outputs required in the callback and fails
finalization if any were not published. Use a plain finalizer when partial
results are acceptable. To return one step's output unchanged with its exact
type, use `finalize: normalize`; see the
[precise result recipe](../examples/precise-result.ts).

Let `definePipeline` infer its type arguments to keep literal IDs. For an explicit
result contract, annotate the finalizer's return type rather than passing
explicit generics, which default the ID type to `string`:

```ts
type Summary = { count: number };

const CountPipeline = definePipeline({
  id: "count-rows",
  steps: [load, normalize],
  finalize: requireOutputs([normalize], ({ normalize }): Summary => ({
    count: normalize.length,
  })),
});
```

## 4. Run or preview the pipeline

```ts
const value = await ImportPipeline.runOrThrow({ lines });
const report = await ImportPipeline.run({ lines }, { continueOnError: true });
const plan = ImportPipeline.plan({ dryRun: true });
const normalizePlan = ImportPipeline.plan({ targets: ["normalize"] });
```

- `runOrThrow` returns the finalized value on success and throws
  `PipelineExecutionError` for any unsuccessful run, even with `continueOnError`.
- `run` returns a report with step statuses, errors, timings, and any result.
  Check `report.finalized` to narrow `report.value`.
- `plan` shows which steps are selected or skipped without executing steps or
  validating inputs.
- `targets` selects declared goals plus their required inputs and failure gates;
  `stepIds` is an exact filter and cannot be combined with `targets`. See
  [core concepts](./concepts.md).

For a CLI script, wrap the pipeline with `definePipelineCommand` from
`tubeless/cli` to get help, selection, dry-run flags, and cancellation. See
[`cli-job.ts`](../examples/cli-job.ts).

## 5. Define a project

Collect pipelines with `defineProject`:

```ts
import { defineProject } from "tubeless/project";

const project = defineProject("data-jobs", [ImportPipeline, SummaryPipeline]);
const summary = await project.get("import-summary").runOrThrow({ lines });
```

`get` returns the exact pipeline with its own option and result types. A project
is an immutable collection; the pipeline's own methods do the work. For YAML or
JSON, see [declarative pipelines](./declarative-pipelines.md).

## 6. Draw the pipeline

```ts
const diagram = ImportPipeline.toMermaid({ direction: "LR" });
```

This returns Mermaid flowchart text without running anything; `tubeless graph`
produces the same output ([the CLI](./cli.md)).

## 7. Test without real delays

```ts
import { createPipelineTestRuntime } from "tubeless/testing";

const test = createPipelineTestRuntime({ cwd: "/workspace" });
const result = await test.run(ImportPipeline, { lines });

test.clock.now();
test.logs;
test.statuses;
test.latestProgress;
```

The test runtime records logs, statuses, and progress, and its default sleep
advances a test clock immediately. Call `test.abort()` to test cancellation. It
does not replace filesystem or network calls; supply fakes where needed.

## Next

Continue with the [recipe index](./recipes.md), or read
[core concepts](./concepts.md) before implementing failure-sensitive writes.
Validate external values with
[`validated-boundaries.ts`](../examples/validated-boundaries.ts), and persist and
inspect local runs with [the studio](./studio.md) or
`tubeless history --trace run.ndjson`.
