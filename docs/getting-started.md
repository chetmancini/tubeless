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

`npx tubeless` is not supported.

## Runtime support

Library imports (`tubeless` and every subpath) are ESM-only and require
Node.js 22 or later. They are dependency-free compiled JavaScript.

The `tubeless` CLI requires Bun 1.3.14 or later. Its shebang is
`#!/usr/bin/env bun`, and Bun loads TypeScript pipeline modules directly.
`npx tubeless` is not a supported way to run the binary.

Supported operating systems are Linux and macOS. Windows is untested.

## 1. Define domain options

Describe only domain input. Built-in controls are added automatically to the
typed run object, while `plan(controls)` accepts controls alone.

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

IDs should remain stable: plans, reports, hooks, tracing, and `stepIds` selection
all use them.

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
text is useful.

Generate the same source directly from a pipeline module without writing a
wrapper script:

```sh
bunx tubeless inspect ./pipelines/import-pipeline.ts
bunx tubeless plan ./pipelines/import-pipeline.ts --target normalize --explain
bunx tubeless graph ./pipelines/import-pipeline.ts
```

The read-only workbench discovers a single exported pipeline automatically.
`inspect` prints identity (`id`, targets, exact steps) plus the default
structural plan. `plan` previews target or exact-step selection without
executing or requiring domain options; it accepts a pipeline or a marked
command and prefers the command when both are exported. Use `--dry-run`,
`--explain`, or `--json` as needed. `graph` emits Mermaid and accepts
`--markdown`. Pass `--export ImportPipeline` when the module exports several
pipelines.

## 5. Pick an execution method

```ts
const value = await ImportPipeline.runOrThrow({ lines });
const report = await ImportPipeline.run({ lines, continueOnError: true });
const plan = ImportPipeline.plan({ dryRun: true });
const normalizePlan = ImportPipeline.plan({ targets: ["normalize"] });
```

- `runOrThrow` returns the finalized value only when the run succeeds and throws
  `PipelineExecutionError` for every unsuccessful run. `continueOnError` may let
  independent steps finish, but it never makes their failures successful.
- `run` always returns the structured pipeline result.
- `plan` describes executor selection without requiring or validating domain options.
- `targets` selects declared downstream goals plus their required inputs and
  failure gates. Optional-only inputs remain excluded. `stepIds` remains an
  exact low-level filter for any step, and cannot be combined with `targets`.
- Every planned step has structured `selectionReasons`, so tools can explain a
  direct target, prerequisite, failure gate, or omission without rebuilding the
  dependency graph. `command.plan()` and `tubeless plan` render the same
  provenance for humans.

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

## 7. Add an interface only at the edge

Library callers can invoke the pipeline directly. Scripts should use
`definePipelineCommand` for generated help, exact `--step` filtering,
dependency-aware `--target` execution for declared goals, dry run, plan mode,
reporting, checkpoints, and SIGINT cancellation. Commands omit `--target` when
the pipeline declares no public targets.

When declared flags already satisfy same-name pipeline options,
`definePipelineCommand` forwards them without `mapOptions`. TypeScript keeps
`mapOptions` required when the command must rename, transform, load, or derive
an option—for example, reading `--source` into the pipeline's `lines` array.

Run an exported pipeline command through the same workbench:

```sh
bunx tubeless run ./scripts/import.ts -- --source rows.txt --target normalize
```

The workbench never executes a raw pipeline or guesses its domain options. It
discovers a `definePipelineCommand` export, then delegates every argument after
`--` to that command's parser, validator, and option mapper. Pass `--export
ImportCommand` before the file when the module exports multiple commands.

Continue with the [recipe index](./recipes.md), or read
[core concepts](./concepts.md) before implementing failure-sensitive writes.

For untrusted boundary values, use the dependency-free Standard Schema support
shown in [`validated-boundaries.ts`](../examples/validated-boundaries.ts).
`createSteps(optionsSchema)` infers caller and validated option types,
`outputSchema` checks values before a step publishes them, and `resultSchema`
checks the finalized public result. Both synchronous and asynchronous schema
validators are supported by `run`; `plan()` remains a schema-free synchronous
preview.

`run()` also returns a versioned `PipelineRun`. It includes the run identity,
terminal status, start and finish timestamps, errors, and one terminal report
per step. Executed step reports expose the same `attemptId` available to the
step context, plus their start and finish timestamps. Structural skips and
steps cancelled before starting intentionally have no attempt ID or start
timestamp. Supply `runId` or `parentRunId` in the runtime context when an
external job system owns those identities; otherwise core generates the run
ID. Use hooks or tracing for streaming logs and progress rather than duplicating
those streams in the terminal run record.

## Optional local run studio

Normal pipeline and CLI execution remains storage-free. Opt into the local
append-only SQLite event store for one workbench run by placing `--store` before
the command file:

```sh
bunx tubeless run --store .tubeless/runs.sqlite ./scripts/import.ts -- --source rows.txt
```

Open the separate studio only when you want it:

```sh
bunx tubeless ui --store .tubeless/runs.sqlite
```

That form is read-only. Explicitly register one or more pipeline command modules
to make a **Run pipeline** action available:

```sh
bunx tubeless ui \
  --store .tubeless/runs.sqlite \
  --command ./scripts/import.ts \
  --command ./scripts/publish.ts
```

The studio does not guess executable modules from recorded definitions. It
accepts only marked `definePipelineCommand` exports supplied at startup, remains
loopback-only when launching is enabled, and renders each command's structured
schema as native controls: booleans become checkboxes, constrained strings
become selects, numbers retain their bounds, and paths and unconstrained values
use text fields. Submitted values still go through the normal typed command
parser without involving a shell; an advanced argument field covers uncommon
fallback cases. **Preview plan** uses the dry-run and step/target values from
the same launch form and expands the structural plan inline. Domain fields stay
available for the eventual run but are not interpreted by the planner;
previewing never creates a run, and it is always optional before **Run**. Steps
that invoke a nested pipeline are labeled with the child pipeline and its
declared steps; runtime fan-out is identified without guessing its item count.

For a repeatable project catalog, declare module references once:

```ts
// tubeless.studio.ts
import { definePipelineStudio } from "tubeless/workbench/studio";

export default definePipelineStudio({
  cwd: ".",
  commands: [
    { file: "./scripts/import.ts", export: "ImportCommand", name: "Import rows" },
    { file: "./scripts/publish.ts", export: "PublishCommand" },
  ],
});
```

```sh
bunx tubeless ui --store .tubeless/runs.sqlite ./tubeless.studio.ts
```

Command paths and `cwd` are relative to the manifest file. The versioned helper
rejects empty or duplicate registrations before the studio starts.

The studio combines active and historical runs in one running-first view. Child
pipeline executions stay beneath their top-level run and are navigable from its
details instead of flooding the main list. Run details include step attempts,
progress, logs, and structured errors.
Programmatic callers can compose the same pieces from `tubeless/run-store/sqlite` and
`tubeless/run-store/ui`; see
[`local-observability.ts`](../examples/local-observability.ts). Neither module
is imported by the core executor or by ordinary CLI runs.
