# Tubeless

<img width="2816" height="1536" alt="Gemini_Generated_Image_6qp28g6qp28g6qp2" src="https://github.com/user-attachments/assets/e41b0e6f-a94c-4684-805a-5ccd21d88f53" />

Typed, observable data pipelines you import from TypeScript or run from a Bun
CLI. It is a library, not a hosted workflow engine or a Make/npm-scripts
replacement.

The first public version is `0.1.0`. The API is still being proven; expect
change before 1.0.

```sh
npm install tubeless
```

Also: `pnpm add tubeless`, `yarn add tubeless`, `bun add tubeless`. Library
imports are ESM-only on Node.js 22+. The `tubeless` CLI requires Bun 1.3.14+;
`npx tubeless` works anywhere with Bun installed and otherwise prints Bun
install instructions. Linux and macOS are supported; Windows is
untested. See [install and runtime](./docs/getting-started.md#install).

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
bunx tubeless inspect ./pipelines/my-pipeline.ts
bunx tubeless plan ./pipelines/my-pipeline.ts --target publish --explain
bunx tubeless graph ./pipelines/my-pipeline.ts --markdown
bunx tubeless run ./pipelines/my-command.ts -- --source input.json --target publish
```

The CLI loads TypeScript modules with Bun. `inspect`, `plan`, and `graph`
accept a pipeline or a `definePipelineCommand` export. `run` executes only a
command export; application flags go after `--`. `history` lists recorded
`--store` runs without opening the studio. See
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

## Next

- [Getting started](./docs/getting-started.md)
- [CLI](./docs/cli.md)
- [Local studio](./docs/studio.md)
- [Core concepts](./docs/concepts.md)
- [Comparison](./docs/comparison.md)
- [Documentation map](./docs/README.md)
- [Generated API inventory](./docs/api-reference.md)
- [Agent guide](./docs/agent-guide.md)

## Contributing

Pull requests are accepted for now; the maintainer set stays small. See
[CONTRIBUTING.md](./CONTRIBUTING.md). Report vulnerabilities privately
through [SECURITY.md](./SECURITY.md).

## License

MIT
