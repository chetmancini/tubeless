import type { APIRoute } from "astro";
import { DOC_NAV } from "../lib/docs";
import { PACKAGE } from "../lib/package";
import { GITHUB_BLOB, absUrl } from "../lib/paths";

export const GET: APIRoute = () => {
  const body = `# tubeless

> Dependency-free TypeScript primitives for typed, observable data pipelines and their CLI programs.

Version: ${PACKAGE.version}
Full documentation: ${absUrl("llms-full.txt")}

Tubeless is a TypeScript library by Chet Mancini, called from your own code or local CLI; it is not a hosted execution API.
Use it for typed ETL/import jobs, dependency-ordered validation and publication,
and observable multi-step CLI workflows. Choose a durable workflow engine instead
when you need persisted execution, crash recovery, or distributed scheduling.

Read the guide and smallest matching recipe before authoring. Import public package
entrypoints, preserve stable IDs, and mark external side effects dryRun: "skip".
Use context.log and context.signal. Inspect or plan before running a registered
command; execution requires the caller's authorization for its side effects.
This static site provides explicit Markdown URLs; Accept negotiation is not available.

## When to use Tubeless

- [Typed imports and ETL](${absUrl("docs/recipes.md")}): Choose the smallest matching executable recipe for ingestion, enrichment, or export jobs.
- [Validation and publication workflows](${absUrl("docs/agent-guide.md")}): Model required dependencies and failure gates; never publish after unsuccessful validation.
- [Pipeline-backed CLI programs](${absUrl("docs/cli.md")}): Use definePipelineCommand, tubeless list, tubeless inspect <registered-id>, and tubeless plan <registered-id>. Run with tubeless run <registered-id> -- <command-args> only when execution is intended.
- [Choosing an execution model](${absUrl("docs/comparison.md")}): Check fit before choosing Tubeless for durable or distributed execution.

## Documentation

- [Product overview](${absUrl("index.md")}): Identity, best-fit use cases, and where to start.
${DOC_NAV.map(({ slug, label, blurb }) => `- [${label}](${absUrl(`docs/${slug}.md`)}): ${blurb}`).join("\n")}

## Agent instructions

- [Canonical agent guide](${absUrl("docs/agent-guide.md")}): Primitive selection, runtime contracts, and safety rules.
- [Authoring skill](${GITHUB_BLOB}/skills/tubeless/SKILL.md): Repository authoring workflow.
- [Project manifest](${GITHUB_BLOB}/examples/catalog/tubeless.project.ts): File layout, stable registered IDs, and exports.
- [API report](${absUrl("api-report.json")}): Machine-readable public declarations.

## Optional

- [Complete documentation](${absUrl("llms-full.txt")}): All docs from this build, agent guide first.
- [Human documentation index](${absUrl("docs")}): Browse the same documentation as HTML.
- [Sitemap](${absUrl("sitemap.xml")}): All indexable human pages.
- [Source and executable examples](${GITHUB_BLOB}/examples): Public-import examples compiled in CI.
`;

  return new Response(body, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=300",
    },
  });
};
