# YAML and JSON pipelines

Use `compilePipelineDocument(document, registry)` from `tubeless/project` to turn
a parsed YAML or JSON document and a registry of functions into ordinary
pipelines. The document owns step identities, dependencies, targets, and
policies; application code owns the handlers, schemas, and command parameters.

The compiler is dependency-free: it does not parse YAML, import modules, or run
application code. Bring your own YAML parser; JSON works with `JSON.parse`.

## Validate quickly

```sh
tubeless validate pipelines.yaml
tubeless validate --json pipelines.yaml
```

This checks document structure and metadata without importing handlers. Exit
code 0 is valid, 4 is a file, parse, or document failure, and 1 is invalid usage.
To check handler names, references, cycles, and targets, load the compiled
command with `tubeless inspect` or `tubeless plan`. Domain schemas run only
during execution. The CLI's Bun YAML parser can overwrite duplicate mapping keys;
use a parser that rejects them when that matters.

## JSON Schema and metadata

The [pipeline document JSON Schema](./pipeline-document.schema.json) (version 1,
draft 2020-12) is also served at
`https://tubeless.io/schemas/pipeline-document-v1.schema.json`. Associate it for
editor autocomplete:

```yaml
# yaml-language-server: $schema=https://tubeless.io/schemas/pipeline-document-v1.schema.json
version: 1
metadata:
  name: Race weekend
  description: Prepare the riders and publish a validated start list.
  authors: [Race operations]
  date: "2026-09-17"
pipelines:
  # Pipeline definitions go here.
```

A top-level `$schema` string is accepted but never fetched. Every `metadata`
field is optional and descriptive only (`date` is a quoted `YYYY-MM-DD`); it
never changes compiled pipelines. The compiled value exposes it as immutable
`compiled.metadata`, which you can reuse when registering a project:

```ts
import { compilePipelineDocument, defineProject } from "tubeless/project";

const compiled = compilePipelineDocument(document, registry);
const project = defineProject("data-jobs", compiled.pipelines, {
  name: compiled.metadata?.name,
  description: compiled.metadata?.description,
});
```

Project IDs and `cwd` belong to registration; nothing is inherited implicitly.
Individual pipelines may declare their own `name` and `description`, which
compiled commands inherit.

For custom CLI inputs, build a command from `compiled.get(id)` and register it in
the project's entry list:

```ts
import { definePipelineCommand } from "tubeless/cli";

const pipeline = compiled.get("yaml-import");
const command = definePipelineCommand(pipeline, {
  params: { lines: { type: "string" } },
  mapOptions: ({ lines }) => ({ lines: lines.split(",") }),
});

export default defineProject("yaml-jobs", [command]);
```

Only the selected pipeline is registered; compiled children still run through
composition without becoming project entries.

## Try the examples

The [loader and commands](../examples/yaml-pipelines.ts) use Bun's native YAML
imports. The [document](../examples/declarative/pipelines.yaml) describes four
pipelines sharing a [handler registry](../examples/declarative/handlers.ts),
including `fromPipeline`, `forEachPipeline`, and an empty-input policy skip.

```sh
bunx tubeless plan --project examples/project/tubeless.project.ts yaml-import --target normalize --explain
bunx tubeless run --project examples/project/tubeless.project.ts yaml-import -- --lines " Alpha , Beta , "
bunx tubeless ui examples/project/tubeless.project.ts
```

The CLI takes the command module or registered ID, not a bare YAML file. For a
larger seven-step graph with concurrent handlers, retries, gates, and dry runs,
see [YAML Peloton](../examples/yaml-peloton.ts) and its
[document](../examples/declarative/peloton.yaml); all work is simulated.

## Document format

```yaml
version: 1
pipelines:
  import:
    optionsSchema: lines
    targets: [normalize]
    steps:
      - id: normalize
        fromPipeline:
          pipeline: normalize-all
          adapter: allRows
        skip: noRows
    finalize:
      run: normalizedRows
      requireOutputs: [normalize]

  normalize-all:
    optionsSchema: lines
    steps:
      - id: normalize
        forEachPipeline:
          pipeline: normalize-one
          adapter: eachRow
        skip: noRows
    finalize:
      run: normalizedRows
      requireOutputs: [normalize]

  normalize-one:
    optionsSchema: line
    steps:
      - id: normalize
        run: normalizeLine
    finalize:
      run: normalizedLine
      requireOutputs: [normalize]
```

Each key in `pipelines` is a pipeline ID; step IDs are local to their pipeline.
Every pipeline needs at least one step and a finalizer. Forward references are
allowed, dependencies (not file order) determine execution order, and composition
cycles are rejected.

| Field                            | Meaning                                                                                |
| -------------------------------- | -------------------------------------------------------------------------------------- |
| Pipeline `name`, `description`   | Optional presentation; the mapping key remains the stable ID                           |
| `optionsSchema`                  | Name in `registry.optionsSchemas`; validates/transforms domain options                 |
| `resultSchema`                   | Name in `registry.schemas`; validates/transforms the final result                      |
| `targets`                        | Public target step IDs, using normal dependency closure                                |
| Step `id`, `name`, `description` | Stable identity and optional presentation text                                         |
| Step `run`                       | Function name in `registry.steps`                                                      |
| Step `fromPipeline`              | `pipeline` (child ID in this document) and `adapter` (`registry.fromPipelineAdapters`) |
| Step `forEachPipeline`           | `pipeline` and `adapter` (`registry.forEachPipelineAdapters`)                          |
| Step `dependsOn`                 | Required dependency step IDs                                                           |
| Step `optionalDependsOn`         | Optional dependency step IDs; not pulled into target selection                         |
| Step `skipAfterFailureOf`        | Failure gates, without providing outputs                                               |
| Step `skip`                      | Predicate name in `registry.skipPredicates`                                            |
| Step `dryRun`                    | `skip`, or for ordinary steps `{ run: previewHandler }` from `registry.steps`          |
| Ordinary step `outputSchema`     | Name in `registry.schemas`; validates/transforms the published output                  |
| `finalize.run`                   | Function name in `registry.finalizers`                                                 |
| `finalize.requireOutputs`        | Required output step IDs, compiled through `requireOutputs`                            |

Every step declares exactly one of `run`, `fromPipeline`, or `forEachPipeline`.
An adapter is application code supplying the same hooks as the TypeScript
builders: `mapOptions` and optional `controls` and `mapResult` for
`fromPipeline`; `items`, `key`, `mapOptions`, and optional `controls`,
`concurrency`, `progress`, and `mapResult` for `forEachPipeline`. Keep fan-out
keys stable and unique.

Semantics match the engine (see [core concepts](./concepts.md)). Omitted `dryRun`
runs the normal handler during a dry run, so mark writes `dryRun: skip`.

## Compile and select pipelines

```ts
import { compilePipelineDocument } from "tubeless/project";

// `document` is the unknown result of your YAML or JSON parser.
// `registry` explicitly imports and registers your application functions.
const compiled = compilePipelineDocument(document, registry);
const pipeline = compiled.get("import");

const plan = pipeline.plan({ targets: ["normalize"] });
const result = await pipeline.runOrThrow({ lines: [" Alpha ", "Beta"] });
```

Step handlers receive `(inputs, context)`, with outputs keyed by step ID (for
example `inputs.load`) and domain options in `context.options`. Finalizers
receive `(outputs, context)`; without `requireOutputs` they must handle absent
outputs. Skip predicates receive `(inputs, context)` and return a
`StepSkipDecision`.

`compilePipelineDocument` returns an immutable `CompiledPipelineDocument` with
`pipelines`, `get(id)` (throws for unknown IDs), and `metadata`. Each pipeline ID
compiles to one shared instance, and compilation registers no project. The
registry has `steps` and `finalizers` maps plus optional `skipPredicates`,
`fromPipelineAdapters`, `forEachPipelineAdapters`, `optionsSchemas` (must produce
objects), and `schemas` (Standard Schema v1). Functions are resolved once at
compile time.

YAML cannot provide TypeScript's inferred wiring: handler inputs and results are
`unknown`, options are `object`, and pipeline IDs are `string`. Narrow them or
validate at the boundary; the compiler does not prove schema compatibility.

## User decisions, confirmations, and text

Register async `run` handlers that wait for input. Use `waitForInput(...).run`
from `createSteps` for the same waiting progress and cancellation behavior as
TypeScript input steps. The application supplies the terminal, browser form, or
other adapter; CLI and Studio do not render questions automatically. Version 1
has no YAML `waitForInput`, `question`, or `choices` fields.

| Question                        | Adapter reply                        | Output validation       |
| ------------------------------- | ------------------------------------ | ----------------------- |
| Select a/b/c from a list        | A stable choice value, such as `"b"` | An allowed-value schema |
| Yes/no or "confirm proceeding?" | `true` or `false`                    | A boolean schema        |
| Open text                       | A string                             | A string schema         |

A confirmation referring to an upstream result:

```yaml
- id: approval
  run: confirmProceeding
  dependsOn: [output]
  outputSchema: yesNo
  dryRun: skip
- id: proceed
  run: proceed
  dependsOn: [output, approval]
  skip: declined
  dryRun: skip
```

Register the handler, schema, and decline predicate:

```ts
import { createSteps } from "tubeless";
import type { ProjectRegistry } from "tubeless/project";

const { waitForInput } = createSteps<object>();
const registry: ProjectRegistry = {
  steps: {
    prepareOutput: () => "xyz",
    confirmProceeding: waitForInput("approval", {
      read: ({ output }: Record<string, unknown>, context) => {
        if (typeof output !== "string") throw new Error("Expected output");
        return readFromYourUI(`Output was ${output}. Confirm proceeding?`, context.signal);
      },
    }).run,
    proceed: ({ output }) => output,
  },
  schemas: {
    yesNo: {
      "~standard": {
        version: 1,
        vendor: "example",
        validate: (value) =>
          typeof value === "boolean"
            ? { value }
            : { issues: [{ message: "Expected a boolean confirmation" }] },
      },
    },
  },
  skipPredicates: {
    declined: ({ approval }) => (approval === false ? "User declined" : false),
  },
  finalizers: {},
};
```

- The adapter must return an actual boolean. `false` is a valid answer: the
  predicate skips `proceed` and the pipeline can succeed. Invalid answers fail
  output validation before dependents start; put retry-on-invalid in the adapter.
- Only the helper's `.run` is registered, so declare `dependsOn`, `outputSchema`,
  and `dryRun` in the document. The helper's default dry-run skip does not carry
  over: use `dryRun: skip` to avoid prompting, or `dryRun: { run: previewApproval }`.
- If skipped input leaves outputs absent, use a finalizer that handles absence,
  or `requireOutputs` when a missing answer must block finalization.
- Forward `context.signal` so cancellation releases the UI. The application owns
  persistence across restarts.

See the [YAML input recipe](../examples/yaml-user-input.ts) and its
[document](../examples/declarative/user-input.yaml).

## Validation and limits

- Parse errors belong to the YAML parser, which must reject duplicate keys itself.
- Malformed documents, unknown fields, and unresolved names throw
  `PipelineDocumentError` (`TUBELESS_DOCUMENT_INVALID`, with a document `path`).
  Duplicate step IDs, cycles, conflicting edges, and invalid target/finalizer
  combinations throw `PipelineDefinitionError`.
- Compilation and `plan()` never invoke handlers or schemas, but loading your
  registry can run module initialization code. Registry functions are trusted
  application code.
- Version 1 supports ordinary steps, single-child composition, child fan-out, and
  skip predicates. Remote steps, caching, expressions, inline code, external
  pipeline references, and per-step graph metadata are not document features; use
  TypeScript authoring for those.
- To expose compiled pipelines to the CLI and Studio, register them with
  `defineProject` and export it from a project module. Pipelines whose options
  schema exposes Standard JSON Schema metadata get automatic commands; others
  need `definePipelineCommand` adapters in the entry list.
