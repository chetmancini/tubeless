# Getting started

## Install

Library consumers install the package and import it from Node.js 22 or later:

```sh
npm install tubeless
```

The same package works with `pnpm add tubeless`, `yarn add tubeless`, and
`bun add tubeless`. The README quick start is a complete first program.

The `tubeless` CLI is separate: it requires Bun 1.3.14 or later.

```sh
bunx tubeless --help
```

Command-by-command usage is in [the CLI](./cli.md).

## Runtime support

Library imports (`tubeless` and every subpath) are ESM-only and require
Node.js 22 or later. They are dependency-free compiled JavaScript.

The `tubeless` CLI requires Bun 1.3.14 or later. Its shebang is
`#!/usr/bin/env node`: the binary relaunches itself with Bun when run under
Node, and Bun loads TypeScript pipeline modules directly. When Bun is missing,
the binary prints install instructions instead of a raw interpreter error.

Supported operating systems are Linux and macOS. Windows is untested.

## 1. Define domain options

Describe only domain input. Built-in controls are a separate argument to
`run(options, controls?)` and `runOrThrow(options, controls?)`. `plan(controls)`
accepts controls alone.

```ts
interface ImportOptions {
  lines: readonly string[];
}

const lines = ["  First row  ", "", "Second row"];
```

## 2. Create typed steps

Call `createSteps` once for the pipeline. Declare dependencies with step object
references; their output types become the dependent step's input types.

```ts
import { createSteps } from "tubeless";

const step = createSteps<ImportOptions>();

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

`finalize` receives the outputs that completed. `requireOutputs` declares which
ones a valid result needs, makes them non-optional in the callback, and reports
a finalization error when a dry run, exact filter, or failure leaves one absent.
Use a plain finalizer when partial output is itself a valid result.

`targets` on the definition declares the pipeline's supported downstream goals.
Only those literal IDs are accepted by target selection and shown by pipeline
commands. When `requireOutputs` is used, definition construction rejects a
declared target whose dependency closure cannot produce the required result.

## 4. Visualize the static graph

`toMermaid` returns dependency-free Mermaid flowchart source without planning or
running the pipeline. It uses `name` when present and otherwise displays the
stable step ID.

```ts
const diagram = ImportPipeline.toMermaid({ direction: "LR" });
```

Required data dependencies use solid arrows. Optional inputs and failure gates
use labeled dotted arrows. Set `includeDescriptions: true` when the extra node
text is useful. The same source is available from `tubeless graph`; see
[the CLI](./cli.md).

## 5. Pick an execution method

```ts
const value = await ImportPipeline.runOrThrow({ lines });
const report = await ImportPipeline.run({ lines }, { continueOnError: true });
const plan = ImportPipeline.plan({ dryRun: true });
const normalizePlan = ImportPipeline.plan({ targets: ["normalize"] });
```

- `runOrThrow` returns the finalized value only when the run succeeds and throws
  `PipelineExecutionError` for every unsuccessful run. `continueOnError` may let
  independent steps finish, but it never makes their failures successful.
- `run` always returns the structured pipeline result.
- `plan` describes executor selection without requiring or validating domain options.
- `targets` selects declared downstream goals plus their required inputs and
  failure gates. `stepIds` is an exact low-level filter and cannot be combined
  with `targets`. See [core concepts](./concepts.md) for selection provenance.

Library callers invoke the pipeline directly. Scripts should use
`definePipelineCommand` so help, `--target`, `--step`, dry run, and
cancellation stay generated instead of hand-parsed. See [the CLI](./cli.md)
and [`cli-job.ts`](../examples/cli-job.ts).

## 6. Test with deterministic runtime plumbing

```ts
import { createPipelineTestRuntime } from "tubeless/testing";

const test = createPipelineTestRuntime({ cwd: "/workspace" });
const result = await test.run(ImportPipeline, { lines });

test.clock.now();
test.logs;
test.statuses;
test.latestProgress;
```

The default sleep advances the test clock immediately. The harness also owns
an abort controller and provides typed `runOrThrow` and `plan` helpers. It has
no test-framework dependency; use ordinary assertions against its structured
captures and pipeline results.

## Next

Continue with the [recipe index](./recipes.md), or read
[core concepts](./concepts.md) before implementing failure-sensitive writes.

For untrusted boundary values, use the Standard Schema support in
[`validated-boundaries.ts`](../examples/validated-boundaries.ts). Persist and
inspect local runs with [the studio](./studio.md).
