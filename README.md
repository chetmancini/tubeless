# Tubeless

Dependency-free TypeScript primitives for typed, observable data pipelines and CLIs.

```sh
npm install tubeless
```

Also: `pnpm add tubeless`, `yarn add tubeless`, `bun add tubeless`. See
[Install](./docs/getting-started.md#install).

## Quick start

```ts
import { createSteps, definePipeline, requireOutputs } from "tubeless";

interface ImportOptions {
  lines: readonly string[];
}

const step = createSteps<ImportOptions>();

const load = step("load", {
  run: (_inputs, context) => context.options.lines,
});

const normalize = step("normalize", {
  dependsOn: [load],
  run: ({ load: rows }) => rows.map((row) => row.trim().toLowerCase()).filter(Boolean),
});

export const ImportPipeline = definePipeline({
  id: "import",
  steps: [load, normalize],
  targets: [normalize],
  finalize: requireOutputs([normalize], ({ normalize }) => normalize),
});

const rows = await ImportPipeline.runOrThrow({ lines: [" Alpha ", "", "Beta"] });
// ["alpha", "beta"]
```

`createSteps` describes domain options only. Runs accept built-in controls
beside them; `plan(controls)` needs no domain input.

Library imports are ESM-only on Node.js 22+. The `tubeless` CLI requires Bun
1.3.14+. See [runtime support](./docs/getting-started.md#runtime-support).

The definition's `targets: [normalize]` declares `normalize` as a supported
downstream goal. Pass `{ lines, targets: ["normalize"] }` to run that goal with its
required inputs and failure gates. Use `stepIds: ["normalize"]` only for exact
low-level filtering; it intentionally does not add prerequisites. `requireOutputs`
makes the outputs needed by a valid final result non-optional. A declared target whose closure cannot satisfy those outputs is rejected when the pipeline is defined.

Use `runOrThrow` when failure should throw. Use `run` when the caller needs the
complete structured report, `plan` when nothing should execute, and `toMermaid`
to document the static graph without planning a run.

## Inspect, plan, graph, or run a module

```sh
bunx tubeless inspect ./pipelines/my-pipeline.ts
bunx tubeless plan ./pipelines/my-pipeline.ts --target publish --explain
bunx tubeless graph ./pipelines/my-pipeline.ts --markdown
bunx tubeless run ./pipelines/my-command.ts -- --source input.json --target publish
```

The workbench auto-discovers one export or accepts `--export Name`. `inspect`
shows identity plus the default plan; `plan` accepts a pipeline or marked
command; and `graph` writes Mermaid. `run` accepts only an exported
`definePipelineCommand`, whose validated application flags follow `--`. Exit
codes are `0` success, `1` usage, `2` load, `3` definition, `4` validation, `5`
planning, `6` execution, and `7` cancellation. Bun loads TypeScript pipeline
modules directly; library entrypoints remain dependency-free JavaScript.

Local history is opt-in with `tubeless run --store`; `tubeless ui` starts the studio.
A studio catalog generates typed run forms; see [local observability](./examples/local-observability.ts).

## Choose the right pattern

| You need to…                              | Start with                                                                |
| ----------------------------------------- | ------------------------------------------------------------------------- |
| Run typed steps in dependency order       | [Sequential pipeline](./examples/typed-import.ts)                         |
| Validate external boundary values         | [Validated boundaries](./examples/validated-boundaries.ts)                |
| Preview writes safely                     | [Dry runs and write gates](./examples/publish-with-gates.ts)              |
| Skip work intentionally at runtime        | [Conditional step](./examples/conditional-step.ts)                        |
| Continue independent work after a failure | [Best-effort execution](./examples/best-effort.ts)                        |
| Reuse a pipeline inside another           | [Child pipeline](./examples/child-pipeline.ts)                            |
| Run one child pipeline for many items     | [Fan-out and progress](./examples/fan-out-progress.ts)                    |
| Resume long API work safely               | [Retry, rate limit, and checkpoint](./examples/resumable-enrichment.ts)   |
| Turn a pipeline into a typed script       | [Pipeline CLI](./examples/cli-job.ts)                                     |
| Render plans and errors consistently      | [Human and JSON rendering](./examples/rendering.ts)                       |
| Test deterministic execution              | [Cancellation and test injection](./examples/cancellation-and-testing.ts) |
| Export lifecycle telemetry                | [Structured tracing](./examples/tracing.ts)                               |
| Persist and inspect local runs            | [Local observability](./examples/local-observability.ts)                  |

The [recipe index](./docs/recipes.md) explains when to use each pattern and
which primitives it demonstrates.

## Core concepts

- Dependencies are step object references, so TypeScript derives each input's
  output type. Invalid static graphs fail when the pipeline is defined. Step IDs
  remain literal, stable machine identities for reports, plans, and CLI filters.
  Set `name` only when printed output should use a friendlier display name; it
  never changes dependency keys or selection.
- Public targets are declared with step references on `definePipeline`. Only
  their literal IDs are accepted by `targets` and exposed as `pipeline.targetIds`;
  internal steps remain available through exact `stepIds` when needed. Plans
  expose machine-readable selection provenance for either mode.
- `dependsOn` supplies required data. `optionalDependsOn` supplies data when
  available. `skipAfterFailureOf` is a failure guard without a data dependency.
- Set `dryRun: "skip"` on filesystem writes, database mutation, publication,
  and other steps whose normal `run` must never execute in a dry run. A custom
  `dryRun` handler may return a typed preview instead. Use `skip` for a
  deliberate runtime policy decision; a policy skip may publish a fallback
  value.
- `step.fromPipeline` composes one opaque child. `step.forEachPipeline` maps a
  child over runtime items with stable keys and bounded concurrency.
- Steps receive logging, progress, cancellation, timing, and injected sleep
  through their context. Runs stay silent unless the caller installs a reporter.

Read [core concepts](./docs/concepts.md) for the execution and failure model.

## Public entrypoints

| Import                  | Purpose                                                       |
| ----------------------- | ------------------------------------------------------------- |
| `tubeless`              | Pipelines, plans, reports, progress, and hooks                |
| `tubeless/reporter`     | Optional TTY plain and interactive run reporters              |
| `tubeless/cli`          | Typed commands, pipeline commands, and interactive selection  |
| `tubeless/node`         | Checkpoints, paths, environment variables, and JSON file IO   |
| `tubeless/batch`        | Chunking and bounded-concurrency scheduling                   |
| `tubeless/retry`        | Retry with backoff, jitter, cancellation, and attempt context |
| `tubeless/run-store/*`  | Append-only projections, optional SQLite, and local studio    |
| `tubeless/rate-limit`   | Interval-based request spacing                                |
| `tubeless/render`       | Shared human and JSON plan/diagnostic rendering               |
| `tubeless/testing`      | Deterministic runtime with captured status and progress       |
| `tubeless/tracing`      | Structured lifecycle tracing contracts                        |
| `tubeless/tracing/json` | Newline-delimited JSON trace exporter                         |
| `tubeless/tracing/otel` | Adapter for an application-owned OpenTelemetry tracer         |

## Learn and inspect

- [Documentation map](./docs/README.md)
- [Getting started](./docs/getting-started.md)
- [Recipe index](./docs/recipes.md)
- [Child-pipeline composition](./docs/child-pipeline-composition.md)
- [Generated API inventory](./docs/api-reference.md)
- [Agent guide](./docs/agent-guide.md)

The [API report](./docs/api-report.json) makes public surface changes reviewable.

## Validate changes

From a clone, `make install` then `make check`. Run `make help` for more.

## License

MIT
