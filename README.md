<p align="center">
  <a href="https://tubeless.io/">
    <img src="docs/assets/logo.svg" width="72" height="72" alt="Tubeless">
  </a>
</p>
<h1 align="center">Tubeless</h1>
<p align="center">
  Typed execution pipelines. Keep your workflow rolling.
</p>
<p align="center">
  <a href="https://www.npmjs.com/package/tubeless"><img alt="npm" src="https://img.shields.io/npm/v/tubeless?style=flat-square&labelColor=121212&color=c4a046"></a>
  <a href="https://github.com/chetmancini/tubeless/actions/workflows/check.yml"><img alt="check" src="https://img.shields.io/github/actions/workflow/status/chetmancini/tubeless/check.yml?style=flat-square&label=check&labelColor=121212&color=2f6f4a"></a>
  <a href="./LICENSE"><img alt="MIT" src="https://img.shields.io/npm/l/tubeless?style=flat-square&labelColor=121212&color=c4c0b4"></a>
</p>

Tubeless is a TypeScript toolkit for work that unfolds in steps. It fits data
pipelines, multi-step application workflows, and AI workloads—anywhere you want
explicit dependencies, typed handoffs, and inspectable execution.

Pipelines run in your process with no runtime dependencies. You can preview
execution, select a target and its dependencies, compose child pipelines, and
track progress. An optional CLI and local studio help you run and inspect jobs.
For scheduling or crash recovery, pair it with a [queue or workflow engine](./docs/comparison.md).

## Installation

```sh
npm install tubeless
```

The library uses ESM and requires Node.js 22 or later. The CLI also requires
Bun 1.3.14 or later. Linux and macOS are supported; Windows is untested.
See [installation and runtime support](./docs/getting-started.md#install).

Tubeless is pre-1.0, so the public API may change between releases.

## Quick start

This pipeline loads and normalizes strings. `step` creates a step; dependencies give typed
inputs. Adding `skip` makes it skippable and widens its output to include `undefined`.

```ts
import { createSteps, definePipeline } from "tubeless";

interface ImportOptions {
  lines: readonly string[];
}

const { step } = createSteps<ImportOptions>();

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
});

const rows = await ImportPipeline.runOrThrow({ lines: [" Alpha ", "", "Beta"] });
// ["alpha", "beta"]
```

Omitted `targets` and `finalize` use the last step in execution order: `normalize`.
Missing output returns `undefined`; use `requireOutputs` when absence should fail.

`runOrThrow` returns the result or throws on failure. Use `run` for reports, `plan`
for previews, and `toMermaid` for diagrams. See [getting started](./docs/getting-started.md).

## Use the CLI

Define commands with `tubeless/cli` and catalogs with `tubeless/project`.
The [CLI guide](./docs/cli.md) explains how to set up the manifest and commands.
With an `import-rows` command registered, you can run:

```sh
bunx tubeless list # reads ./tubeless.project.ts
bunx tubeless inspect import-rows
bunx tubeless run import-rows -- --source input.json
```

The CLI loads TypeScript modules with Bun. Pass application flags after `--`.
Record runs with `--store` or save a portable trace with `--trace`, then inspect
them with `tubeless history` or the [local studio](./docs/studio.md).

## Find your route

- Start with a [typed import](./examples/typed-import.ts) or add
  [dry runs and write gates](./examples/publish-with-gates.ts) to a publishing job.
- Build a larger workflow with [child pipelines](./examples/child-pipeline.ts)
  and [fan-out](./examples/fan-out-progress.ts).
- Take the [peloton example](./examples/peloton.ts) for a spin: a road-race weekend
  workflow that brings several pipeline features together.

The [recipe index](./docs/recipes.md) covers validation, retries, tracing, testing,
and more. For help authoring pipelines with a coding agent, install the
[agent skill pack](./docs/agent-skills.md) with `npx skills add chetmancini/tubeless`.

## Documentation

[Website](https://tubeless.io/) · [Getting started](./docs/getting-started.md) · [CLI](./docs/cli.md) ·
[Studio](./docs/studio.md) · [Concepts](./docs/concepts.md) ·
[Comparison](./docs/comparison.md) · [API](./docs/api-reference.md) ·
[Agents](./docs/agent-guide.md)

## Contributing

Bug reports, documentation improvements, and focused pull requests are welcome.
Open an [issue](https://github.com/chetmancini/tubeless/issues) before starting a
large change or changing the public API. See [CONTRIBUTING.md](./CONTRIBUTING.md)
for local setup and checks, and [SECURITY.md](./SECURITY.md) to report a vulnerability privately.

## License

[MIT](./LICENSE)
