import type { APIRoute } from "astro";
import { DOC_NAV } from "../lib/docs";
import { PACKAGE } from "../lib/package";
import { GITHUB_BLOB, absUrl } from "../lib/paths";

export const GET: APIRoute = () => {
  const body = `# tubeless

> A TypeScript library for data pipelines and multi-step CLI workflows, with no runtime dependencies.

Version: ${PACKAGE.version}
Full documentation: ${absUrl("llms-full.txt")}

Tubeless is a TypeScript library by Chet Mancini. Run pipelines from your code or
the CLI for data imports, validation and publication jobs, or scripts that need
progress reporting. Pipelines run in your process. Use an external workflow engine
when you need persisted execution, crash recovery, or distributed scheduling.

Read the guide and simplest example that fits your task before writing a pipeline. Import public package
entrypoints, preserve stable IDs, and mark external side effects dryRun: "skip".
Use context.log and context.signal. Inspect or plan before running a registered
command; execution requires the caller's authorization for its side effects.
This static site provides explicit Markdown URLs; Accept negotiation is not available.

## When to use Tubeless

- [Typed imports and ETL](${absUrl("docs/recipes.md")}): Choose the smallest matching executable recipe for ingestion, enrichment, or export jobs.
- [Validation and publication workflows](${absUrl("docs/agent-guide.md")}): Model required dependencies and failure gates; never publish after unsuccessful validation.
- [Pipeline-backed CLI programs](${absUrl("docs/cli.md")}): Export defineProject to expose schema-backed pipelines to tubeless list, tubeless inspect <pipeline-id>, and tubeless plan <pipeline-id>. Run with tubeless run <pipeline-id> -- <command-args> only when execution is intended. Use definePipelineCommand for custom CLI adapters.
- [Choosing an execution model](${absUrl("docs/comparison.md")}): See how Tubeless fits next to other tools and frameworks.

## Documentation

- [Product overview](${absUrl("index.md")}): What Tubeless does and how to get started.
- [Use cases](${absUrl("use-cases.md")}): CI/CD, ML flows, LLM workflows, data pipelines, and operational workflows, with example workflows and runnable code.
- [Developer resources](${absUrl("developers.md")}): Package docs, CLI reference, Studio guide, and machine-readable resources.
${DOC_NAV.map(({ slug, label, blurb }) => `- [${label}](${absUrl(`docs/${slug}.md`)}): ${blurb}`).join("\n")}

## Agent instructions

- [Agent guide](${absUrl("docs/agent-guide.md")}): How to choose pipeline features and handle execution, failures, and side effects.
- [Skill pack](${absUrl("docs/agent-skills.md")}): Install with npx skills add chetmancini/tubeless; use tubeless-make-pipeline to convert existing code.
- [Authoring skill](${GITHUB_BLOB}/skills/tubeless/SKILL.md): Write and review pipelines in your project.
- [Code conversion skill](${GITHUB_BLOB}/skills/tubeless-make-pipeline/SKILL.md): Convert existing code into a pipeline while preserving its behavior.
- [Pipeline project](${GITHUB_BLOB}/examples/tubeless.project.ts): Group pipelines with defineProject for typed lookup, CLI, and Studio.
- [YAML pipelines](${GITHUB_BLOB}/examples/yaml-pipelines.ts): Compile documents with compilePipelineDocument, use compiled.get(id) directly, and register selected pipelines with defineProject. Reuse compiled.metadata for project presentation.
- [API report](${absUrl("api-report.json")}): Machine-readable public declarations.
- [Pipeline document JSON Schema v1](${absUrl("schemas/pipeline-document-v1.schema.json")}): Validate YAML or JSON document structure and metadata without importing handlers.

## Optional

- [Complete documentation](${absUrl("llms-full.txt")}): All docs from this build, agent guide first.
- [Human documentation index](${absUrl("docs")}): Browse the same documentation as HTML.
- [Sitemap](${absUrl("sitemap.xml")}): All indexable human pages.
- [Source and executable examples](${GITHUB_BLOB}/examples): Examples that import the public package and compile in CI.
`;

  return new Response(body, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=300",
    },
  });
};
