# Graph metadata and discovery

Attach `metadata` to `definePipeline` or any step constructor to describe ownership,
domains, tags, and application annotations. Metadata never changes execution,
selection, dependencies, ordering, dry runs, or failure handling; stable IDs remain
the execution identity, and declared targets select operational goals.

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
are rejected. Pipeline and step metadata are separate, and nothing inherits or
merges, including across child pipeline wrappers.

Compilation deeply freezes a copy, so later edits to your objects cannot change
plans or recorded definitions. Values must be plain JSON (null, booleans, finite
numbers, strings, dense arrays, plain objects); functions, accessors, class
instances, cycles, and sparse arrays are rejected. Limits: 16,384 UTF-8 bytes per
metadata object, nesting depth 8, at most 64 tags, and 256 characters for each tag,
owner, and domain. Omit secrets: metadata is recorded and displayed as supplied.

## Query and diagram semantics

`querySteps(plan, query)` returns matching plan steps in execution order. Filters
combine with AND, every requested tag must match, and comparisons are exact and
case-sensitive. Empty filters match everything; steps without metadata never match a
specified owner, domain, or tag. Queries do not change the plan's selection, so a
match may be an unselected step, and prerequisites are not added.

`toMermaid({ query, includeMetadata: true })` renders matching steps and only edges
whose endpoints are both visible; no match yields just the flowchart header.

```sh
bunx tubeless inspect --tag sensitive --owner analytics --json ./pipeline.ts
bunx tubeless graph --domain customers --metadata ./pipeline.ts
```

Repeat `--tag` to require several. `inspect` filters `stepIds` and `plan.steps`
while the definition snapshot and target IDs stay complete. These filters belong to
`inspect` and `graph`; `run` and `plan` keep using `--target` and `--step`.

Studio plan previews and recorded definitions show metadata. On a pipeline's
**Versions** tab, **Explore steps** searches IDs and metadata (case-insensitive
substring) or groups steps by owner or domain, with a separate **Unassigned** group.
These controls do not affect launches.

## Recording and compatibility

Trace `pipeline.started` events carry pipeline and step metadata in
`definitionSnapshot`, so application-owned exporters can enrich output without
parsing descriptions. Metadata is part of the definition identity, so Studio treats a
metadata edit as a new definition. Object key order does not affect identity; array
order, including tag order, does. A fingerprint never proves equal handler code; set
`implementationVersion` for that. If a definition exceeds the trace snapshot limit,
its identity is kept but metadata browsing and comparison are unavailable.

Definitions with metadata use identity version 3, which readers older than that
version cannot decode; definitions without metadata keep their existing hashes.

Metadata is supported in TypeScript definitions only. Declarative pipeline documents
(version 1) reject `metadata` on pipelines and steps. Their document-level
`metadata` (`name`, `description`, `authors`, `date`) is unrelated and does not flow
into compiled pipelines.
