import type { APIRoute } from "astro";
import { absUrl } from "../lib/paths";

export const GET: APIRoute = () => new Response(`# Tubeless developer resources

Find guides for building TypeScript pipelines, running CLI commands, and using
Studio. API references cover the supported library exports.

## Package and CLI

- [Developer documentation](${absUrl("docs.md")})
- [Getting started](${absUrl("docs/getting-started.md")})
- [Executable recipes](${absUrl("docs/recipes.md")})
- [CLI reference](${absUrl("docs/cli.md")})
- [TypeScript API inventory](${absUrl("docs/api-reference.md")})
- [Machine-readable API report](${absUrl("api-report.json")})

## Local Studio

- [Local Studio API guide](${absUrl("docs/studio.md")})

## Agents

- [Agent documentation](${absUrl("agents.md")})
- [Machine-readable documentation index](${absUrl("llms.txt")})
- [Complete documentation bundle](${absUrl("llms-full.txt")})
`, { headers: { "content-type": "text/markdown; charset=utf-8" } });
