import type { APIRoute } from "astro";
import { DOC_NAV } from "../lib/docs";
import { absUrl } from "../lib/paths";

export const GET: APIRoute = () => new Response(`# Tubeless documentation

These pages document the Tubeless package. Agents should begin with the agent
guide and the smallest recipe matching the requested pipeline.

${DOC_NAV.map(({ label, slug, blurb }) => `- [${label}](${absUrl(`docs/${slug}.md`)}): ${blurb}`).join("\n")}

- [Agent documentation index](${absUrl("llms.txt")})
- [Developer resources](${absUrl("developers.md")})
- [Complete documentation](${absUrl("llms-full.txt")})
- [Machine-readable API report](${absUrl("api-report.json")})
`, { headers: { "content-type": "text/markdown; charset=utf-8" } });
