import type { APIRoute } from "astro";
import { absUrl, githubBlob } from "../lib/paths";

export const GET: APIRoute = () => new Response(`# Tubeless agent documentation

Start with the machine-readable documentation index, then read the agent guide
and the simplest example that fits your task before writing a Tubeless pipeline.

Install the skill pack with \`npx skills add chetmancini/tubeless\`.
Use \`tubeless-make-pipeline\` to convert existing code into a typed pipeline,
or \`tubeless\` for writing and editing pipelines.

- [Skill pack installation and example prompt](${absUrl("docs/agent-skills.md")})
- [Documentation index](${absUrl("llms.txt")})
- [Complete documentation](${absUrl("llms-full.txt")})
- [Agent guide](${absUrl("docs/agent-guide.md")})
- [Recipes](${absUrl("docs/recipes.md")})
- [Developer resources](${absUrl("developers.md")})
- [Authoring skill](${githubBlob("skills/tubeless/SKILL.md")})
- [Code conversion skill](${githubBlob("skills/tubeless-make-pipeline/SKILL.md")})
- [Pipeline project](${githubBlob("examples/tubeless.project.ts")}): Group pipelines with defineProject for typed lookup, CLI, and Studio.
- [YAML pipelines](${githubBlob("examples/yaml-pipelines.ts")}): Compile parsed documents with compilePipelineDocument, use compiled.get(id), and register selected pipelines.
- [Machine-readable API report](${absUrl("api-report.json")})
`, { headers: { "content-type": "text/markdown; charset=utf-8" } });
