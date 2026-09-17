# YAML and JSON pipelines

Use `compilePipelineDocument` from `tubeless/declarative` to turn a parsed YAML
or JSON document and a registry of functions into ordinary pipelines. The
document owns step identities, dependencies, targets, and policies; application
code owns the handlers, schemas, and command parameters.

The compiler belongs to the dependency-free `tubeless/project` entrypoint alongside
project catalogs. It does not parse YAML,
import modules, or run application code. Use your runtime's YAML support or a
parser of your choice. JSON works through `JSON.parse` without another package.

## Validate quickly

Validate a document without importing any handlers:

```sh
tubeless validate pipelines.yaml
tubeless validate --json pipelines.yaml
```

In this repository, use `make validate FILE=examples/declarative/peloton.yaml`,
or build once and run `bun dist/workbench/workbench-bin.js validate --json
examples/declarative/peloton.yaml`. Exit code 0 means valid structure; 4 means a
file, parse, or document validation failure; 1 means invalid command usage.
JSON output includes `ok`, the file path, pipeline IDs and metadata on success,
or a diagnostic with a document path when available.

This checks structure and metadata only. To check registered handler names,
dependency references, cycles, and targets, load the compiled command with
`tubeless inspect` or `tubeless plan`. Domain schemas run only during execution.
The CLI's Bun YAML parser can overwrite duplicate mapping keys; choose a parser
with duplicate-key rejection when that check is required.

For application code, `validatePipelineDocument(parsed)` from `tubeless/project`
returns a validated copy of the document. It does not require a registry.

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

`validatePipelineDocument` preserves metadata and `tubeless validate --json`
reports it. Compilation produces the same pipeline map regardless of metadata.
Studio command labels still come from explicit command registrations; document
metadata does not override labels, IDs, options, or run timestamps.

## Try the example

From the repository root, build once and use the registered examples:

```sh
bun run build
bun dist/workbench/workbench-bin.js plan --project examples/catalog/tubeless.project.ts yaml-import --target normalize --explain
bun dist/workbench/workbench-bin.js run --project examples/catalog/tubeless.project.ts yaml-import -- --lines " Alpha , Beta , "
bun dist/workbench/workbench-bin.js ui examples/catalog/tubeless.project.ts
```

Studio lists **Import rows from YAML** and **Preview rows from YAML**. Their
command parameters supply the input forms; the normal preview and run controls
use the compiled pipelines. Browser launches record the same events as
TypeScript-authored pipelines.

The [loader and commands](../examples/yaml-pipelines.ts) use Bun's native YAML
imports. The [document](../examples/declarative/pipelines.yaml) describes two
pipelines sharing an explicit [handler registry](../examples/declarative/handlers.ts).
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

Open `make ui STUDIO=examples/catalog/tubeless.project.ts` and select
**Peloton from YAML** to use the same demo in Studio. Its form exposes delay,
inspection concurrency, and both failure switches. Keep a nonzero delay to
watch progress or try cancellation. Plan without running any handlers:

```sh
make plan FILE=yaml-peloton PROJECT=examples/catalog/tubeless.project.ts ARGS="--target publish-start-list --explain"
```

The publication target selects the tech gate and its prerequisites, but omits
the independent audit. Per-rider inspection runs through `runConcurrent` inside
one ordinary step, with explicit progress details and retry events. This is
not the TypeScript Peloton's child-pipeline fan-out: YAML v1 has no child
composition or runtime skip predicates. The demo exercises the existing format
without adding new syntax.

## Document format

```yaml
version: 1
pipelines:
  import:
    optionsSchema: lines
    targets: [normalize]
    steps:
      - id: load
        description: Read caller-provided lines.
        run: loadRows
      - id: normalize
        description: Normalize the loaded rows.
        run: normalizeRows
        dependsOn: [load]
    finalize:
      run: normalizedRows
      requireOutputs: [normalize]
```

Each key in `pipelines` is a pipeline ID. Step IDs are local to that pipeline;
registry names can be reused across pipelines. Each pipeline requires at least
one step and a finalizer. Forward references are allowed. Dependencies determine
execution order using the existing engine, not the order in the file alone.

| Field                            | Meaning                                                                                |
| -------------------------------- | -------------------------------------------------------------------------------------- |
| `optionsSchema`                  | Name in `registry.optionsSchemas`; validates/transforms domain options                 |
| `resultSchema`                   | Name in `registry.schemas`; validates/transforms the final result                      |
| `targets`                        | Public target step IDs, using normal dependency closure                                |
| Step `id`, `name`, `description` | Stable identity and optional presentation text                                         |
| Step `run`                       | Function name in `registry.steps`                                                      |
| Step `dependsOn`                 | Required dependency step IDs                                                           |
| Step `optionalDependsOn`         | Optional dependency step IDs; optional-only steps are not pulled into target selection |
| Step `skipAfterFailureOf`        | Failure gates, without providing dependency outputs                                    |
| Step `dryRun`                    | `skip`, or `{ run: previewHandler }` naming a function in `registry.steps`             |
| Step `outputSchema`              | Name in `registry.schemas`; validates/transforms the published output                  |
| `finalize.run`                   | Function name in `registry.finalizers`                                                 |
| `finalize.requireOutputs`        | Required output step IDs, compiled through `requireOutputs`                            |

Omitted `dryRun` runs the normal handler during a dry run. Mark writes with
`dryRun: skip` or supply a side-effect-free preview handler. A skipped required
output can prevent finalization; the compiler preserves the engine's existing
semantics. See [core concepts](./concepts.md).

## Registry and programmatic use

```ts
import { compilePipelineDocument } from "tubeless/declarative";

// `document` is the unknown result of your YAML or JSON parser.
// `registry` explicitly imports and registers your application functions.
const pipelines = compilePipelineDocument(document, registry);
const pipeline = pipelines.get("import");
if (!pipeline) throw new Error("Missing import pipeline");

const plan = pipeline.plan({ targets: ["normalize"] });
const result = await pipeline.runOrThrow({ lines: [" Alpha ", "Beta"] });
```

Step handlers receive `(inputs, context)`. Required and available optional
dependency outputs are keyed by step ID, e.g. `inputs.load`. Domain options
live in `context.options`. Use the normal `context.log`, `context.signal`,
`context.sleep`, and progress APIs. Finalizers receive `(outputs, context)`;
without `requireOutputs`, they must handle absent outputs themselves.

The registry has separate `steps` and `finalizers` function maps, plus optional
`optionsSchemas` and `schemas` maps. Schemas use Standard Schema v1.
`optionsSchemas` must accept and produce objects, matching Tubeless domain
options. `schemas` can validate any step-output or final-result shape. Functions
are resolved once during compilation; modifying a registry later does not
replace handlers in an already compiled pipeline.

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

This first version supports ordinary steps. Child pipelines, fan-out, remote
steps, runtime skip predicates, expressions, and inline code are not document
features. Use TypeScript authoring for those workflows. CLI and Studio loading
still use explicit `definePipelineCommand` registration; the YAML file does not
grant execution access or define a new Studio protocol.
