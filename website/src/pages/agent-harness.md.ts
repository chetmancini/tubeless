import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { APIRoute } from "astro";
import { absUrl, githubBlob } from "../lib/paths";

export const GET: APIRoute = () => new Response(`# Agents are pipelines

An agent is a pipeline of LLM turns and tool calls. The model chooses what runs next. Tubeless runs the steps and keeps track of what happened.

Tool calls are steps. Subagents are child pipelines. You can trace the whole run, reuse a pipeline as a tool, or put an agent in the middle of a larger workflow.

Each model turn can choose a new batch of registered tools or finish. [Watch an illustrated run](${absUrl("agent-harness")}) to see tool calls branch, a subagent run its own pipeline, and results feed the next model turn.

## Use agents wherever you use pipelines

A pipeline can ask an agent to investigate a problem, then pass its answer to the next step. An agent can call an existing pipeline as a tool, or delegate work to another agent.

It is the same execution model in both directions. Inputs and outputs are validated. Each child agent has its own state, and its work counts toward the parent's execution limits.

- Use fromPipeline to run an agent inside a workflow and consume its answer: [composition example](${githubBlob("examples/agent-pipeline.ts")}).
- Use pipelineTool to give an agent a capability you have already built: [delegation example](${githubBlob("examples/agent-delegation.ts")}).
- Add your own tool handlers with defineTool: [custom tool example](${githubBlob("examples/agent-workspace.ts")}).

## Start with a model and a task

Save this as agent.ts:

\`\`\`ts
${readFileSync(join(__REPO_ROOT__, "examples/agent-model.ts"), "utf8").trim()}
\`\`\`

It gives the model a coding prompt, project instructions from AGENTS.md, conversation history, and six workspace tools: read, edit, write, bash, list, and search.

Add your own tools and instructions as needed. The core is provider-independent: use the OpenAI adapter shown here, supply another model callback, or write your own decision logic with defineAgent.

Install tubeless, set OPENAI_API_KEY in your environment, then run from a disposable workspace with Bun 1.3.14+:

\`\`\`sh
npm install tubeless
bunx tubeless run --trace agent.ndjson ./agent.ts -- --task "Find and fix the failing test, then verify the change."
bunx tubeless history --trace agent.ndjson
\`\`\`

This makes paid model calls and uses your machine's file and shell permissions. Run it in a workspace you are comfortable letting it change.

## Runs in your process

Set limits on turns, calls, nesting, and concurrency. Cancel with an AbortSignal. Record history to NDJSON or SQLite. The runtime has no dependencies, and you do not need a separate service to run an agent.

Inspect which tools were called, what failed, and which subagent did the work. Parent and child runs stay connected in the history.

Supply an execution environment to route workspace tools and project guidance to a remote service. Child agents inherit it. [Try the environment recipe](${githubBlob("examples/agent-environment.ts")}).

Execution is in process; crash-safe resume is not supported yet. The default workspace tools use host permissions. Your environment backend supplies isolation.

- [Agent documentation](${absUrl("docs/agents.md")})
- [Examples and recorded runs](${absUrl("agent-examples.md")})
`, { headers: { "content-type": "text/markdown; charset=utf-8" } });
