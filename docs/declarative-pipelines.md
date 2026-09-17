# YAML and JSON pipelines

Use `compilePipelineDocument` from `tubeless/declarative` to turn a parsed YAML
or JSON document and a registry of functions into ordinary pipelines. The
document owns step identities, dependencies, targets, and policies; application
code owns the handlers, schemas, and command parameters.

The compiler is an optional, dependency-free entrypoint. It does not parse YAML,
import modules, or run application code. Use your runtime's YAML support or a
parser of your choice. JSON works through `JSON.parse` without another package.

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
