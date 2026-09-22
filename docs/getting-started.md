# Getting started

This guide builds a small pipeline that loads, normalizes, and returns a list of
rows. It then shows how to run the pipeline, preview selected steps, and test it.

## Install

Install the package in your TypeScript project. Library imports require Node.js 22.6 or later:

```sh
npm install tubeless
```

The same package works with `pnpm add tubeless`, `yarn add tubeless`, and
`bun add tubeless`. The README quick start is a complete first program.

Add `tubeless/cli` for terminal commands, and
`tubeless/project` for pipeline projects. Neither import loads storage or Studio;
the executable supplies those optional tools.
The executable requires Bun 1.3.14 or later:

```sh
bunx tubeless --help
```

Command-by-command usage is in [the CLI](./cli.md).

## Runtime support

Library imports (`tubeless` and every subpath) are ESM-only and require
Node.js 22.6 or later. They are dependency-free compiled JavaScript.

The executable uses `#!/usr/bin/env bun`, so Bun must be installed and available
on `PATH` even when npm or `npx` installs the package.

Supported operating systems are Linux and macOS. Windows is untested.

## Try the CLI

From a Tubeless checkout, list and run a pipeline directly from a project:

```sh
bunx tubeless list --project examples/tubeless.project.ts
bunx tubeless inspect --project examples/tubeless.project.ts validated-import
bunx tubeless run --project examples/tubeless.project.ts validated-import -- --source rows.txt
```

The project contains only pipelines. The workbench derives `--source` from the
pipeline's input schema; there is no command wrapper.

In your app, export `defineProject("my-app", [MyPipeline])` from
`tubeless.project.ts`, then run `bunx tubeless list` with no `--project`.
Pipelines whose options schema exposes Standard JSON Schema input metadata get
their flags automatically. Register commands directly in the list for custom command inputs
or presentation. See [`examples/automatic-cli.ts`](../examples/automatic-cli.ts),
[`examples/project/tubeless.project.ts`](../examples/project/tubeless.project.ts),
and [the CLI](./cli.md).

## 1. Define domain options

Start with the data your pipeline needs. Here, the caller supplies an array of
lines. Options such as dry-run mode and step selection control execution, so
they are passed separately from this input.

```ts
interface ImportOptions {
  lines: readonly string[];
}

const lines = ["  First row  ", "", "Second row"];
```

## 2. Create typed steps

Call `createSteps` once and take its `step` constructor for these options. The
`load` step returns the input lines. The `normalize` step declares `dependsOn: [load]`,
so it receives the output of `load` as a typed input. TypeScript infers that
`rows` is a read-only array of strings.

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

IDs should remain stable: plans, reports, hooks, tracing, and CLI selection all
use them.

## 3. Define the result

A single-goal pipeline needs only its ID and steps:

```ts
import { definePipeline } from "tubeless";

const ImportPipeline = definePipeline({
  id: "import",
  steps: [load, normalize],
});
```

Running without selection controls selects every step. Omitted definition
`targets` exposes the last step in execution order, `normalize`, as a public goal
callers can explicitly select. Running with `{ targets: ["normalize"] }` selects
it and `load`, because normalization requires its output; unrelated steps would
be excluded.
Omitted `finalize` returns that step's output. Its type includes all possible step
outputs plus `undefined`; here, callers can read it as `readonly string[] | undefined`.
If a dry run or filter leaves the output absent, the result is `undefined`.
The dependency graph determines execution order, with declaration order breaking
ties between ready steps. These defaults use that full order even when a run
filters or skips steps. An unfiltered run still executes all steps.

Provide `targets` to expose different goals, or `targets: []` to expose none.
Provide `finalize` to transform outputs or require them explicitly:

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

`requireOutputs` makes those output properties required in the callback and fails
finalization if any were not published. Tubeless checks that every public target,
including an implicit last-step target, includes the required finalizer steps.
Use a plain finalizer when your application intentionally accepts partial results.

## 4. Run or preview the pipeline

```ts
const value = await ImportPipeline.runOrThrow({ lines });
const report = await ImportPipeline.run({ lines }, { continueOnError: true });
const plan = ImportPipeline.plan({ dryRun: true });
const normalizePlan = ImportPipeline.plan({ targets: ["normalize"] });
```

- `runOrThrow` returns the finalized value only when the run succeeds and throws
  `PipelineExecutionError` for every unsuccessful run. `continueOnError` may let
  independent steps finish, but it never makes their failures successful.
- `run` returns a report with step statuses, errors, timings, and any final result.
  Use it when your caller needs to inspect failed or partially completed work.
  Check `report.finalized` to narrow `report.value` to the exact result type;
  a failed best-effort run may still be finalized.
- `plan` shows which steps are selected and which will be skipped. It does not
  execute steps or validate domain inputs.
- `targets` selects declared downstream goals plus their required inputs and
  failure gates. `stepIds` is an exact low-level filter and cannot be combined
  with `targets`. See [core concepts](./concepts.md) for examples of both controls.

For a CLI script, import `definePipelineCommand` from `tubeless/cli` and
wrap the pipeline. It supplies help, target and step selection, dry-run flags,
and cancellation handling. See [the CLI](./cli.md) and
[`cli-job.ts`](../examples/cli-job.ts).

## 5. Define a project

Collect application pipelines by passing them directly to `defineProject`:

```ts
import { defineProject } from "tubeless/project";

const project = defineProject("data-jobs", [ImportPipeline, SummaryPipeline]);
const summary = await project.get("import-summary").runOrThrow({ lines });
```

The stable project ID remains literal on `project.id`. Pipeline IDs do too, so
`get` returns the exact pipeline with its own option and result types. For union
or widened pipeline IDs, `get` retains all matching candidate types. A project
is only an immutable collection; the selected pipeline's existing methods do the
work. For YAML or JSON, call `compilePipelineDocument(document, registry)` first,
then use `compiled.get(id)` directly or register selected compiled pipelines;
see [declarative pipelines](./declarative-pipelines.md).

Use `finalize: normalize` when the pipeline should require and return that step's
output unchanged. The result keeps the step's exact output type; filtering it out
or structurally skipping it makes finalization fail. See the
[precise result recipe](../examples/precise-result.ts).

Let `definePipeline` infer its type arguments to preserve literal IDs. If you need
an explicit result contract, annotate the finalizer's return type:

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

`CountPipeline.id` retains the literal `"count-rows"`, and its result is `Summary`.
Calls such as `definePipeline<Steps, Result>(...)` instead default the omitted ID
type argument to `string`. TypeScript does not infer the remaining parameters
after explicit type arguments; adding another generic or overload cannot change
that rule for the same call syntax. Those pipelines still run, but project lookup
accepts string IDs and checks missing IDs at runtime. See
[TypeScript's generic parameter defaults](https://www.typescriptlang.org/docs/handbook/2/generics.html#generic-parameter-defaults).

## 6. Draw the pipeline

`toMermaid` returns Mermaid flowchart text describing the step dependencies.
It does not run the pipeline. It uses `name` when present and otherwise displays the
stable step ID.

```ts
const diagram = ImportPipeline.toMermaid({ direction: "LR" });
```

Required data dependencies use solid arrows. Optional inputs and failure gates
use labeled dotted arrows. Set `includeDescriptions: true` when the extra node
text is useful. The same source is available from `tubeless graph`; see
[the CLI](./cli.md).

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

The test runtime records logs, status changes, and progress. Its default sleep
advances a test clock immediately, so tests do not wait in real time. Call
`test.abort()` to test cancellation. Use your test framework's assertions to
check the captured events and results.

The test runtime does not replace filesystem or network calls. Supply fake
I/O in tests that must avoid real side effects.

## Next

Continue with the [recipe index](./recipes.md), or read
[core concepts](./concepts.md) before implementing failure-sensitive writes.

To validate values from files or external services, use the Standard Schema
support in [`validated-boundaries.ts`](../examples/validated-boundaries.ts). Persist and
inspect local runs with [the studio](./studio.md), or open a finished portable
trace with `tubeless history --trace run.ndjson`.
