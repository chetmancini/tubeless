# Graph metadata and discovery

Attach `metadata` to `definePipeline` or any step constructor to describe ownership,
domains, tags, and application annotations. Metadata does not change execution,
selection, dependencies, ordering, dry runs, or failure handling. Stable IDs remain
the execution identity; use declared targets to select operational goals.

See the executable [metadata recipe](../examples/graph-metadata.ts).

```ts
import { createSteps, definePipeline, querySteps } from "tubeless";

const { step } = createSteps();
const summarize = step("summarize", {
  metadata: {
    owner: "analytics",
    domain: "customers",
    tags: ["sensitive", "aggregate"],
    annotations: { retentionDays: 30 },
  },
  run: () => ({ count: 12 }),
});
const pipeline = definePipeline({
  id: "customer-summary",
  metadata: { owner: "data-platform" },
  steps: [summarize],
});

const matches = querySteps(pipeline.plan(), { tags: ["sensitive"], owner: "analytics" });
const diagram = pipeline.toMermaid({ query: { domain: "customers" }, includeMetadata: true });
```

`PipelineMetadata` has four optional fields: `tags`, `owner`, `domain`, and
`annotations`. Put application fields inside `annotations`; unknown top-level fields
are rejected. Pipeline metadata and each step's metadata remain separate. Nothing
inherits or merges, including across child pipeline wrappers. Child metadata is
available in the child's own plan and recorded definition.

Compilation copies and deeply freezes metadata, including nested annotations.
Later edits to the author's objects cannot change plans, diagrams, or recorded
definitions. Values must be plain JSON: null, booleans, finite numbers, strings,
dense arrays, and plain objects. Undefined values, functions, symbols, accessors,
class instances, cycles, and sparse arrays are rejected without invoking getters
or `toJSON`. Each metadata object is limited to 16,384 UTF-8 bytes, 256 visited
values, and nesting depth 8 (the root is depth 0). Keys and strings also consume a
conservative JSON encoding budget. Tags allow at most 64 nonblank strings; tags,
owners, and domains have a 256-character limit. Omit secrets: metadata is recorded
and displayed as supplied.

## Query and diagram semantics

`querySteps(plan, query)` returns matching plan steps in execution order. Filters
combine with AND, every requested tag must match, and comparisons are exact and
case-sensitive. Empty filters match every step. Missing metadata does not match a
specified owner, domain, or tag. Queries leave the plan and its selection state
unchanged, so a match may be an unselected step. Prerequisites are not added.
Applications can check the returned metadata against their own conventions.

`toMermaid({ query, includeMetadata: true })` renders matching steps and only edges
whose endpoints are both visible. An empty match produces just the flowchart
header. Metadata labels are escaped like other Mermaid labels. The complete
pipeline remains available for ordinary planning and execution.

```sh
bunx tubeless inspect --tag sensitive --owner analytics --json ./pipeline.ts
bunx tubeless graph --domain customers --metadata ./pipeline.ts
```

Repeat `--tag` to require several tags. `inspect` filters `stepIds` and `plan.steps`;
the definition snapshot and declared target IDs remain complete context. Text
inspection displays metadata. `graph --metadata` includes it in node labels.
These filters belong to `inspect` and `graph`; `run` and `plan` continue using
execution controls such as `--target` and `--step`.

Studio plan previews and observed definitions show metadata. Expand **Explore
steps** to search IDs and metadata (case-insensitive substring search), or group
matches by owner or domain. Grouping preserves the order of first occurrence;
steps without the selected field appear under **Unassigned**. These controls do
not affect launches.

## Recording and compatibility

Plans expose step metadata and the complete definition snapshot. Pipeline objects
also expose their pipeline metadata. Trace `pipeline.started` events carry both
pipeline and step metadata in `definitionSnapshot`, allowing application-owned
telemetry exporters to enrich their output without parsing descriptions.

Metadata contributes to the structural fingerprint and definition ID, so Studio
retains and compares metadata edits as different definitions. Object key order
does not affect identity; array order, including tag order, does. Definitions with
metadata, and their ancestors, use definition identity version 3. Definitions
without metadata retain their existing version 1 or 2 hashes. New readers continue
to accept those older definitions. Older readers do not understand identity
version 3. Handler equivalence still requires an application-supplied
`implementationVersion`; a fingerprint does not prove equal code.

The existing overall trace snapshot limit still applies: oversized definitions
retain their identity but omit the complete snapshot, so metadata browsing and
comparison are unavailable for those recordings.

This release supports graph metadata in TypeScript definitions. Declarative
pipeline document **version 1** continues to reject `metadata` on pipelines and
steps, and arbitrary unknown fields remain errors. Its existing document-level
`metadata` (`name`, `description`, `authors`, `date`) is unchanged and does not
inherit into compiled pipelines. Graph metadata in declarative documents requires
a future explicit document version and matching JSON Schema.
