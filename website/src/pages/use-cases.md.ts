import type { APIRoute } from "astro";
import { USE_CASES, USE_CASES_INTRO } from "../data/use-cases";
import { absUrl, githubBlob } from "../lib/paths";

export const GET: APIRoute = () => new Response([
  `# Tubeless use cases\n\n${USE_CASES_INTRO}`,
  ...USE_CASES.map((useCase) => [
    `## ${useCase.label}: ${useCase.headline}`,
    useCase.description,
    `Example workflow: ${useCase.stages.join(" → ")}.`,
    ...useCase.benefits.map((benefit) => `### ${benefit.title}\n\n${benefit.detail}`),
    useCase.boundary,
    "### Related examples",
    ...useCase.recipes.map((recipe) => `- [${recipe.label}](${githubBlob(`examples/${recipe.file}`)})`),
    `[${useCase.guide.label}](${absUrl(`docs/${useCase.guide.path}.md`)})`,
  ].join("\n\n")),
  `## Getting started\n\nThe getting started guide walks through a small pipeline. If you’re adapting an existing script with a coding agent, install the Tubeless skill pack.\n\n[Getting started guide](${absUrl("docs/getting-started.md")}) or [agent setup](${absUrl("docs/agent-skills.md")}).`,
].join("\n\n"), { headers: { "content-type": "text/markdown; charset=utf-8" } });
