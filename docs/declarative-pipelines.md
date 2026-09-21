# YAML and JSON pipelines

Use `defineProject(id, document, registry)` from `tubeless/project` to turn a parsed
YAML or JSON document and a registry of functions into an ordinary project. The
document owns step identities, dependencies, targets, and policies; application
code owns the handlers, schemas, and command parameters.

The project compiler remains dependency-free. It does not parse YAML,
import modules, or run application code. Use your runtime's YAML support or a
parser of your choice. JSON works through `JSON.parse` without another package.

## Validate quickly

Validate a document without importing any handlers:

```sh
tubeless validate pipelines.yaml
tubeless validate --json pipelines.yaml
```

In this repository, use `make validate FILE=examples/declarative/peloton.yaml`,
or `bunx tubeless validate --json examples/declarative/peloton.yaml`.
From a Tubeless checkout, `bun run tubeless --` runs the local build.
Exit code 0 means valid structure; 4 means a
file, parse, or document validation failure; 1 means invalid command usage.
JSON output includes `ok`, the file path, pipeline IDs and metadata on success,
or a diagnostic with a document path when available.

This checks structure and metadata only. To check registered handler names,
dependency references, cycles, and targets, load the compiled command with
`tubeless inspect` or `tubeless plan`. Domain schemas run only during execution.
The CLI's Bun YAML parser can overwrite duplicate mapping keys; choose a parser
with duplicate-key rejection when that check is required.

## Downloadable JSON Schema

The [pipeline document JSON Schema](./pipeline-document.schema.json) describes
version 1 using JSON Schema draft 2020-12. The website serves the same file at
`https://tubeless.io/schemas/pipeline-document-v1.schema.json`, with a current
alias at `https://tubeless.io/pipeline-document.schema.json`. It is also packaged
at `docs/pipeline-document.schema.json`. The website's `llms.txt` links to the
versioned URL for agents. Validate parsed YAML against it using a JSON Schema
validator with date-format checking enabled.

For YAML language-server autocomplete and diagnostics, associate the schema:

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

JSON documents can use a top-level `$schema` string; YAML documents may include
it too. Tubeless accepts that association but never fetches it. `version`
selects the document format.

## Document metadata

The optional `metadata` object supports `name`, `description`, `authors` (an
array of names or organizations), and `date` (a quoted `YYYY-MM-DD` calendar
date). All fields are optional. Dates and authors are maintained by the author;
they are not inferred from Git and do not schedule execution.

`tubeless validate --json` preserves and reports metadata. Project compilation
produces the same pipelines regardless of metadata.
`defineProject(id, document, registry)` carries document `name` and `description`
onto the project. `project.name` defaults to `id` when no name is supplied;
`project.description` remains optional. Override either field with an optional
fourth argument:

```ts
const project = defineProject("data-jobs", document, registry, {
  name: "Production data jobs",
  description: "Import and publish production datasets.",
});
```

Overrides apply per field; omitted or `undefined` fields retain the document value.
Project metadata is immutable. Document `authors` and `date` remain document-only.
Each pipeline definition may separately declare `name` and `description`; compiled
commands inherit them. Top-level document metadata does not override pipeline labels,
IDs, options, or run timestamps.

For custom CLI inputs on compiled pipelines, the `commands` option can be a
factory. It receives the project's `get` function after compilation, so adapters
wrap the same pipeline objects that application code retrieves:

```ts
import { definePipelineCommand } from "tubeless/cli";

export default defineProject("yaml-jobs", document, registry, {
  commands: (get) => [
    definePipelineCommand(get("yaml-import"), {
      params: { lines: { type: "string" } },
      mapOptions: ({ lines }) => ({ lines: lines.split(",") }),
    }),
  ],
});
```

## Try the example

From the repository root, use the registered examples:

```sh
bunx tubeless plan --project examples/project/tubeless.project.ts yaml-import --target normalize --explain
bunx tubeless run --project examples/project/tubeless.project.ts yaml-import -- --lines " Alpha , Beta , "
bunx tubeless ui examples/project/tubeless.project.ts
```

Studio lists **Import rows from YAML** and **Preview rows from YAML**. Their
command parameters supply the input forms; the normal preview and run controls
use the compiled pipelines. Browser launches record the same events as
TypeScript-authored pipelines.

The [loader and commands](../examples/yaml-pipelines.ts) use Bun's native YAML
imports. The [document](../examples/declarative/pipelines.yaml) describes four
pipelines sharing an explicit [handler registry](../examples/declarative/handlers.ts).
Its import command uses `fromPipeline`, whose child uses `forEachPipeline` to
normalize each row. Both composed steps use registered application adapters,
and empty input is an intentional policy skip.
Edit the YAML and restart the command or Studio to load the new definition.
The CLI accepts the command module or registered ID, not a bare YAML file.

## Peloton demo

For a larger graph, try [YAML Peloton](../examples/yaml-peloton.ts). Its
[seven-step document](../examples/declarative/peloton.yaml) declares rider
discovery, weather, kit normalization, bike inspection, a separate car audit,
tech validation, and publication. The
[handlers](../examples/declarative/peloton-handlers.ts) simulate all work;
no network requests or filesystem writes occur.

```sh
# Visible progress, concurrent bike inspections, and a simulated radio retry
bun examples/yaml-peloton.ts --delay 200 --concurrency 2

# Substitute the weather preview handler and skip publication
bun examples/yaml-peloton.ts --dry-run --delay 0

# Select validation without publishing or auditing cars
bun examples/yaml-peloton.ts --target validate-tech --delay 0

# An independent audit failure allows publication, but the run still fails
bun examples/yaml-peloton.ts --fail-audit --continue-on-error --delay 0

# Tech failure blocks publication even when independent work may continue
bun examples/yaml-peloton.ts --fail-tech --continue-on-error --delay 0
```

Both failure examples intentionally exit with an execution error. The finalizer
returns a partial summary so dry runs and target selection do not require a
published start list. Option and rider-output schemas validate the dynamic
document boundaries.

Open `make ui STUDIO=examples/project/tubeless.project.ts` and select
**Peloton from YAML** to use the same demo in Studio. Its form exposes delay,
inspection concurrency, and both failure switches. Keep a nonzero delay to
watch progress or try cancellation. Plan without running any handlers:

```sh
make plan FILE=yaml-peloton PROJECT=examples/project/tubeless.project.ts ARGS="--target publish-start-list --explain"
```

The publication target selects the tech gate and its prerequisites, but omits
the independent audit. Per-rider inspection runs through `runConcurrent` inside
one ordinary step, with explicit progress details and retry events. This demo
chooses lightweight in-handler concurrency; the smaller YAML recipe shows
declarative child-pipeline composition and fan-out when each item needs its own
child lifecycle.

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

Each key in `pipelines` is a pipeline ID. Step IDs are local to that pipeline;
registry names can be reused across pipelines. Each pipeline requires at least
one step and a finalizer. Step and pipeline forward references are allowed.
Dependencies determine execution order using the existing engine, not the
order in the file alone. Composition cycles are rejected.

| Field                            | Meaning                                                                                |
| -------------------------------- | -------------------------------------------------------------------------------------- |
| Pipeline `name`, `description`   | Optional command and Studio presentation; the mapping key remains the stable ID        |
| `optionsSchema`                  | Name in `registry.optionsSchemas`; validates/transforms domain options                 |
| `resultSchema`                   | Name in `registry.schemas`; validates/transforms the final result                      |
| `targets`                        | Public target step IDs, using normal dependency closure                                |
| Step `id`, `name`, `description` | Stable identity and optional presentation text                                         |
| Step `run`                       | Ordinary function name in `registry.steps`                                             |
| Step `fromPipeline.pipeline`     | One child pipeline ID in this document                                                 |
| Step `fromPipeline.adapter`      | Name in `registry.fromPipelineAdapters`                                                |
| Step `forEachPipeline.pipeline`  | Fan-out child pipeline ID in this document                                             |
| Step `forEachPipeline.adapter`   | Name in `registry.forEachPipelineAdapters`                                             |
| Step `dependsOn`                 | Required dependency step IDs                                                           |
| Step `optionalDependsOn`         | Optional dependency step IDs; optional-only steps are not pulled into target selection |
| Step `skipAfterFailureOf`        | Failure gates, without providing dependency outputs                                    |
| Step `skip`                      | Runtime predicate name in `registry.skipPredicates`                                    |
| Step `dryRun`                    | `skip`, or for ordinary steps `{ run: previewHandler }` from `registry.steps`          |
| Ordinary step `outputSchema`     | Name in `registry.schemas`; validates/transforms the published output                  |
| `finalize.run`                   | Function name in `registry.finalizers`                                                 |
| `finalize.requireOutputs`        | Required output step IDs, compiled through `requireOutputs`                            |

Every step declares exactly one of `run`, `fromPipeline`, or
`forEachPipeline`. Child references resolve only pipelines in the same
document. The adapter is application code: a `fromPipeline` adapter supplies
`mapOptions` and optional `controls` and `mapResult`; a `forEachPipeline` adapter supplies
`items`, `key`, `mapOptions`, and optional `controls`, `concurrency`, `progress`, and
`mapResult`. These are the same hooks as the TypeScript builders. Parent plans
still expose one opaque wrapper with `nestedPipeline` metadata, and execution
retains the normal nested progress and failure behavior.

Omitted `dryRun` runs the normal handler or child workflow during a dry run.
Mark writes with `dryRun: skip`; ordinary steps can instead supply a
side-effect-free preview handler. A skipped required output can prevent
finalization. A runtime `skip` is a successful policy skip, can publish a value,
and unlocks dependents. The compiler preserves the engine's existing semantics.
See [core concepts](./concepts.md).

## Define a project

```ts
import { defineProject } from "tubeless/project";

// `document` is the unknown result of your YAML or JSON parser.
// `registry` explicitly imports and registers your application functions.
const project = defineProject("imports", document, registry);
const pipeline = project.get("import");

const plan = pipeline.plan({ targets: ["normalize"] });
const result = await pipeline.runOrThrow({ lines: [" Alpha ", "Beta"] });
```

Step handlers receive `(inputs, context)`. Required and available optional
dependency outputs are keyed by step ID, e.g. `inputs.load`. Domain options
live in `context.options`. Use the normal `context.log`, `context.signal`,
`context.sleep`, and progress APIs. Finalizers receive `(outputs, context)`;
without `requireOutputs`, they must handle absent outputs themselves.

`defineProject` validates the document and compiles its pipelines. The registry has
separate `steps` and `finalizers` function maps, plus optional
`skipPredicates`, `fromPipelineAdapters`, `forEachPipelineAdapters`,
`optionsSchemas`, and `schemas` maps. Schemas use Standard Schema v1.
`optionsSchemas` must accept and produce objects, matching Tubeless domain
options. `schemas` can validate any step-output or final-result shape. Functions
are resolved once during compilation; modifying a registry later does not
replace handlers in an already compiled pipeline.

Skip predicates receive `(inputs, context)` and return the normal
`StepSkipDecision`. A single-child adapter's `mapOptions` and dynamic `controls`
receive the same arguments. A fan-out adapter receives the normal `items`, `key`,
`mapOptions`, `controls`, and result-mapping arguments documented for
`forEachPipeline`. Keep stable and
unique keys, and return the complete parent-facing result array from a valued
fan-out skip.

YAML cannot provide TypeScript's inferred graph wiring. Handler inputs and
pipeline results are `unknown`, and handler options are `object`. Narrow them
or validate at the application boundary. Schemas validate runtime values; the
compiler does not prove compatibility between two schemas.

## Validation and limits

Parsing errors belong to the YAML parser. Configure duplicate-key rejection
when available: a compiler cannot recover keys that a parser already overwrote.
Bun's native YAML loader does not provide this guarantee. For strict authoring,
use a parser configured to reject duplicate mapping keys before compilation.

Malformed documents, unknown fields, and unresolved names throw
`PipelineDocumentError`, with code `TUBELESS_DOCUMENT_INVALID` and a document
`path`. Source line/column locations are not retained by this compiler.
Duplicate step IDs, cycles, conflicting edges, and invalid target/finalizer
combinations go through core and throw the existing `PipelineDefinitionError`.

Compilation and `plan()` never invoke handlers or schemas. Business validation
happens during `run()`. Loading an application registry can still execute module
initialization code. Registry functions remain trusted application code.

Version 1 supports ordinary steps, single-child composition, child fan-out, and
runtime skip predicates. Remote steps, expressions, inline code, and external
pipeline references are not document features. Use TypeScript authoring for
those workflows. Export the compiled `defineProject` from a project module for
CLI and Studio loading. Pipelines whose options schemas expose Standard JSON
Schema input metadata receive automatic commands. Custom or schema-less inputs
need `definePipelineCommand` adapters in the project's `commands` option.
A YAML file alone does not grant execution access or define a new Studio protocol.
