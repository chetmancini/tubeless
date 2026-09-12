import type { APIRoute } from "astro";
import { PACKAGE } from "../lib/package";
import { absUrl, GITHUB_REPO } from "../lib/paths";

export const GET: APIRoute = () => new Response(`# Tubeless

> ${PACKAGE.description}

Tubeless by Chet Mancini is a dependency-free TypeScript library for typed data
pipelines and multi-step CLI workflows. Define dependencies, preview execution,
and inspect step results. Version: ${PACKAGE.version}.

## When to use Tubeless

Use it for typed imports and ETL, dependency-ordered validation and publication,
and observable CLI programs. It runs in your process; it is not a hosted API or
a durable execution engine with crash recovery or distributed scheduling.

## Start here

- [Getting started](${absUrl("docs/getting-started.md")})
- [Agent instructions and resource index](${absUrl("llms.txt")})
- [Authoring guide](${absUrl("docs/agent-guide.md")})
- [Recipes](${absUrl("docs/recipes.md")})
- [CLI reference](${absUrl("docs/cli.md")})
- [Complete documentation](${absUrl("llms-full.txt")})
- [Source code](${GITHUB_REPO})

Read the guide and smallest matching recipe before writing a pipeline. Inspect
or plan before execution, and obtain authorization for external side effects.
`, { headers: { "content-type": "text/markdown; charset=utf-8" } });
