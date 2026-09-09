<p align="center">
  <a href="https://chetmancini.github.io/tubeless/">
    <img src="docs/assets/logo.svg" width="72" height="72" alt="Tubeless">
  </a>
</p>
<h1 align="center">Tubeless</h1>
<p align="center">
  Define a typed graph. Plan a target. Run it from Node.
</p>
<p align="center">
  <a href="https://www.npmjs.com/package/tubeless"><img alt="npm" src="https://img.shields.io/npm/v/tubeless?style=flat-square&labelColor=121212&color=c4a046"></a>
  <a href="https://github.com/chetmancini/tubeless/actions/workflows/check.yml"><img alt="check" src="https://img.shields.io/github/actions/workflow/status/chetmancini/tubeless/check.yml?style=flat-square&label=check&labelColor=121212&color=2f6f4a"></a>
  <a href="./LICENSE"><img alt="MIT" src="https://img.shields.io/npm/l/tubeless?style=flat-square&labelColor=121212&color=c4c0b4"></a>
</p>

Typed, observable data pipelines you import from TypeScript or run from a Bun
CLI. It is a library, not a hosted workflow engine or a Make/npm-scripts
replacement. The public line is `0.1.x`; expect API change before 1.0.

```sh
npm install tubeless
```

Also `pnpm add tubeless`, `yarn add tubeless`, or `bun add tubeless`. Library
imports are ESM-only on Node.js 22+. The `tubeless` CLI requires Bun 1.3.14+;
`npx tubeless` works anywhere with Bun installed and otherwise prints Bun
install instructions. Linux and macOS are supported; Windows is untested. See
[install and runtime](./docs/getting-started.md#install).

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

`createSteps` types domain options only. Runs accept built-in controls beside
them. Use `runOrThrow` when failure should throw, `run` for the structured
report, `plan` when nothing should execute, and `toMermaid` for the static
graph.

## Inspect, plan, or run

```sh
bunx tubeless list # reads ./tubeless.project.ts
bunx tubeless inspect import-rows
bunx tubeless run import-rows -- --source input.json
```

The project manifest explicitly registers stable command IDs, module paths, and
execution cwd without scanning the filesystem. The CLI loads TypeScript modules
with Bun; existing file-oriented commands remain available. Application flags
go after `--`. `history` lists recorded
`--store` runs or reads a finished `--trace` artifact without opening the studio. See
[the CLI](./docs/cli.md) and [the local studio](./docs/studio.md).

## Choose the right pattern

| You need to…                                 | Start with                                                                |
| -------------------------------------------- | ------------------------------------------------------------------------- |
| Run typed steps in dependency order          | [Sequential pipeline](./examples/typed-import.ts)                         |
| Validate external boundary values            | [Validated boundaries](./examples/validated-boundaries.ts)                |
| Preview writes safely                        | [Dry runs and write gates](./examples/publish-with-gates.ts)              |
| Skip work intentionally at runtime           | [Conditional step](./examples/conditional-step.ts)                        |
| Continue independent work after a failure    | [Best-effort execution](./examples/best-effort.ts)                        |
| Reuse a pipeline inside another              | [Child pipeline](./examples/child-pipeline.ts)                            |
| Run a step on another engine                 | [Remote steps](./examples/remote-steps.ts)                                |
| Run one child pipeline for many items        | [Fan-out and progress](./examples/fan-out-progress.ts)                    |
| Resume long API work safely                  | [Retry, rate limit, and checkpoint](./examples/resumable-enrichment.ts)   |
| Watch the live TTY reporter                  | [Live TUI](./examples/live-tui.ts)                                        |
| Watch many primitives on a road-race weekend | [Peloton pipeline](./examples/peloton.ts)                                 |
| Turn a pipeline into a typed script          | [Pipeline CLI](./examples/cli-job.ts)                                     |
| Render plans and errors consistently         | [Human and JSON rendering](./examples/rendering.ts)                       |
| Test deterministic execution                 | [Cancellation and test injection](./examples/cancellation-and-testing.ts) |
| Export lifecycle telemetry                   | [Structured tracing](./examples/tracing.ts)                               |
| Persist and inspect local runs               | [Local observability](./examples/local-observability.ts)                  |

The [recipe index](./docs/recipes.md) explains when to use each pattern.

## Docs

[Website](https://chetmancini.github.io/tubeless/) ·
[Getting started](./docs/getting-started.md) · [CLI](./docs/cli.md) ·
[Studio](./docs/studio.md) · [Concepts](./docs/concepts.md) ·
[Comparison](./docs/comparison.md) · [API](./docs/api-reference.md) ·
[Agents](./docs/agent-guide.md)

## Contributing

Pull requests are accepted for now; the maintainer set stays small. See
[CONTRIBUTING.md](./CONTRIBUTING.md). Report vulnerabilities privately
through [SECURITY.md](./SECURITY.md).

## License

[MIT](./LICENSE)
