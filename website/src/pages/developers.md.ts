import type { APIRoute } from "astro";
import { absUrl } from "../lib/paths";

export const GET: APIRoute = () => new Response(`# Tubeless developer resources

Find guides for building TypeScript pipelines, running CLI commands, and using
Studio. API references cover library exports and the HTTP interface of your
local Studio server.

## Package and CLI

- [Developer documentation](${absUrl("docs.md")})
- [Getting started](${absUrl("docs/getting-started.md")})
- [Executable recipes](${absUrl("docs/recipes.md")})
- [CLI reference](${absUrl("docs/cli.md")})
- [TypeScript API inventory](${absUrl("docs/api-reference.md")})
- [Machine-readable API report](${absUrl("api-report.json")})

## Local Studio HTTP API

- [Local Studio API guide](${absUrl("docs/studio.md")})
- [OpenAPI 3.1 specification](${absUrl("openapi.json")})

The OpenAPI server URL is loopback-only. The specification documents typed JSON
success and error responses; tubeless.io hosts the contract but does not execute
pipelines.

## Agents

- [Agent documentation](${absUrl("agents.md")})
- [Machine-readable documentation index](${absUrl("llms.txt")})
- [Complete documentation bundle](${absUrl("llms-full.txt")})
`, { headers: { "content-type": "text/markdown; charset=utf-8" } });
