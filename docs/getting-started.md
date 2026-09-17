# Getting started

This guide builds a small pipeline that loads, normalizes, and returns a list of
rows. It then shows how to run the pipeline, preview selected steps, and test it.

## Install

Install the package in your TypeScript project. Library imports require Node.js 22 or later:

```sh
npm install tubeless
```

The same package works with `pnpm add tubeless`, `yarn add tubeless`, and
`bun add tubeless`. The README quick start is a complete first program.

Add `tubeless/cli` for terminal commands and `tubeless/project` for project
catalogs. Neither import loads storage or Studio; the executable supplies those optional tools.
The executable requires Bun 1.3.14 or later:

```sh
bunx tubeless --help
```

Command-by-command usage is in [the CLI](./cli.md).

## Runtime support

Library imports (`tubeless` and every subpath) are ESM-only and require
Node.js 22 or later. They are dependency-free compiled JavaScript.

`npx tubeless` starts the CLI through Node and then runs it with Bun. If Bun is
missing, the CLI prints installation instructions. On a machine with Bun but no
Node, use `bunx --bun tubeless`.

Supported operating systems are Linux and macOS. Windows is untested.

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

```ts
import { definePipeline, requireOutputs } from "tubeless";

const ImportPipeline = definePipeline({
  id: "import",
  steps: [load, normalize],
  targets: [normalize],
  finalize: requireOutputs([normalize], ({ normalize }) => ({
    count: normalize.length,
    rows: normalize,
  })),
});
```

`finalize` turns step outputs into the value returned to the caller. In this
example, the result needs the normalized rows. `requireOutputs([normalize], ...)`
checks that the output exists and makes it a required property in the callback.
If execution skips or fails to produce it, finalization fails instead of
returning an incomplete result. Use a plain finalizer when your application
intentionally accepts partial results.

`targets: [normalize]` makes normalization an available execution goal. Selecting
that target also selects `load`, because normalization requires its output.
When a finalizer uses `requireOutputs`, Tubeless checks that every declared
target includes the steps needed to produce the final result.

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
- `plan` shows which steps are selected and which will be skipped. It does not
  execute steps or validate domain inputs.
- `targets` selects declared downstream goals plus their required inputs and
  failure gates. `stepIds` is an exact low-level filter and cannot be combined
  with `targets`. See [core concepts](./concepts.md) for examples of both controls.

For a CLI script, import `definePipelineCommand` from `tubeless/cli` and
wrap the pipeline. It supplies help, target and step selection, dry-run flags,
and cancellation handling. See [the CLI](./cli.md) and
[`cli-job.ts`](../examples/cli-job.ts).

## 5. Draw the pipeline

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

## 6. Test without real delays

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
