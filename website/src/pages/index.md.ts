import type { APIRoute } from "astro";
import { PACKAGE } from "../lib/package";
import { absUrl, GITHUB_REPO } from "../lib/paths";

export const GET: APIRoute = () => new Response(`# Tubeless

> ${PACKAGE.description}

Tubeless is a TypeScript library by Chet Mancini for pipelines, from data jobs to
agents. Connect steps, run them, and inspect what happened. It has no runtime
dependencies. Version: ${PACKAGE.version}.

## Agents are pipelines

An agent is a pipeline of LLM turns and tool calls. The model chooses what runs
next. Tubeless runs the steps and keeps track of what happened. Tool calls are
steps; subagents are child pipelines.

You can follow the whole run in one history, use existing pipelines as tools,
and pass an agent's answer to the next step in a workflow.

[Build an agent with Tubeless](${absUrl("agent-harness.md")}).

## When to use Tubeless

Use it for data imports, releases that depend on validation checks, and CLI
programs that need progress reporting. Pipelines run in your process. Crash
recovery and distributed scheduling require an external execution system.

- [Comparison](${absUrl("docs/comparison.md")}): In-process typed pipelines, not a scheduler. Pair with a host engine for crash recovery.

## Start here

If you use a coding agent, [install the Tubeless skills](${absUrl("docs/agent-skills.md")})
for help writing pipelines or adapting an existing script:

\`\`\`sh
npx skills add chetmancini/tubeless
\`\`\`

- [Getting started](${absUrl("docs/getting-started.md")})
- [Use cases](${absUrl("use-cases.md")}): CI/CD, ML flows, LLM workflows, data pipelines, and operational workflows.
- [Brand assets](${absUrl("brand.md")}): Tubeless logos in SVG format.
- [Developer resources](${absUrl("developers.md")})
- [Agent instructions and resource index](${absUrl("llms.txt")})
- [Authoring guide](${absUrl("docs/agent-guide.md")})
- [Recipes](${absUrl("docs/recipes.md")})
- [CLI reference](${absUrl("docs/cli.md")})
- [Complete documentation](${absUrl("llms-full.txt")})
- [Source code](${GITHUB_REPO})

Read the guide and simplest example that fits your task before writing a pipeline. Inspect
or plan before execution, and obtain authorization for external side effects.
`, { headers: { "content-type": "text/markdown; charset=utf-8" } });
