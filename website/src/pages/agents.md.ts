import type { APIRoute } from "astro";
import { absUrl, githubBlob } from "../lib/paths";

export const GET: APIRoute = () => new Response(`# Tubeless agent documentation

Start with the machine-readable documentation index, then read the agent guide
and the smallest matching recipe before writing a Tubeless pipeline.

- [Documentation index](${absUrl("llms.txt")})
- [Complete documentation](${absUrl("llms-full.txt")})
- [Agent guide](${absUrl("docs/agent-guide.md")})
- [Recipes](${absUrl("docs/recipes.md")})
- [Authoring skill](${githubBlob("skills/tubeless/SKILL.md")})
- [Project manifest](${githubBlob("examples/catalog/tubeless.project.ts")})
- [Agent evaluations](${absUrl("docs/agent-evaluations.md")})
- [Local Studio OpenAPI contract](${absUrl("openapi.json")})
- [Machine-readable API report](${absUrl("api-report.json")})
`, { headers: { "content-type": "text/markdown; charset=utf-8" } });
