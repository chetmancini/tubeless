import type { APIRoute } from "astro";
import { USE_CASES, USE_CASES_INTRO } from "../data/use-cases";
import { absUrl, githubBlob } from "../lib/paths";

export const GET: APIRoute = () => new Response([
  `# Tubeless use cases\n\n${USE_CASES_INTRO}`,
  ...USE_CASES.map((useCase) => [
    `## ${useCase.label}: ${useCase.headline}`,
    useCase.description,
    `A workflow you could build: ${useCase.stages.join(" → ")}.`,
    ...useCase.benefits.map((benefit) => `### ${benefit.title}\n\n${benefit.detail}`),
    useCase.boundary,
    "### Start with a recipe",
    ...useCase.recipes.map((recipe) => `- [${recipe.label}](${githubBlob(`examples/${recipe.file}`)})`),
    `[${useCase.guide.label}](${absUrl(`docs/${useCase.guide.path}.md`)})`,
  ].join("\n\n")),
  `## Start with a script you already run.\n\nChoose its inputs, give each stage a name, and connect the outputs. Keep the domain logic in your own functions.\n\n[Build your first pipeline](${absUrl("docs/getting-started.md")}) or [build with your agent](${absUrl("docs/agent-skills.md")}).`,
].join("\n\n"), { headers: { "content-type": "text/markdown; charset=utf-8" } });
