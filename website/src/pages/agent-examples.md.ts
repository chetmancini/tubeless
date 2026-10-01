import type { APIRoute } from "astro";
import recording from "../../public/agent-evaluation.json";
import { RECORDING_CONTEXT, ROOT_INSTRUCTIONS } from "../data/agent-recordings";
import { absUrl, githubBlob } from "../lib/paths";

export const GET: APIRoute = () => new Response(`# Agent examples

Small test tasks that make an agent's execution easy to follow. See what it was asked to do, which files it started with, and how it reached an answer.

[Back to the agent overview](${absUrl("agent-harness.md")}).

## Recorded model runs

These four tasks cover edits, project instructions, and recovery from a missing file. They run in tiny, temporary workspaces; they do not measure performance on a real codebase.

Each recording includes the original task, starting files, expected result, and independent checks. Recorded ${recording.completedAt}, model ${recording.model}, reasoning ${recording.reasoningEffort}. Browsing them makes no model calls.

${recording.results.map(run => {
  const context = RECORDING_CONTEXT[run.id];
  return `### ${context.title}

Task given to the agent:

> ${run.task}

Starting workspace: ${context.setup}

What success looks like: ${context.expected}

${Object.entries({ "AGENTS.md": ROOT_INSTRUCTIONS, ...context.files }).map(([path, content]) => `Starting file: ${path}\n\n\`\`\`text\n${content}\n\`\`\``).join("\n\n")}

Result: ${run.passed ? "passed" : "failed"}; ${run.turns.length} turns. Independent check: ${run.verification}.`;
}).join("\n\n")}

[Step through the recorded turns](${absUrl("agent-examples#recorded-run")}) or [download the recordings](${absUrl("agent-evaluation.json")}). To run these tasks yourself, see the [evaluation script](${githubBlob("scripts/eval-agent.mjs")}). Live evaluations make paid model calls.

## Subagent delegation

This example gives a parent agent two words, red and missing. It delegates each word to a child agent, then combines their answers.

Each child counts and uppercases its word. The uppercase tool deliberately fails on missing; that child reports the error and finishes. The recorded history connects both children to the parent's calls.

The decisions are scripted and the tools execute locally. This example demonstrates composition and error handling without calling a model.

- [Read the example](${githubBlob("examples/agent-delegation.ts")})
- [Download the history](${absUrl("agent-delegation.json")})
`, { headers: { "content-type": "text/markdown; charset=utf-8" } });
