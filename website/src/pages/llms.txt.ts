import type { APIRoute } from "astro";
import { GITHUB_BLOB, absUrl, githubRaw } from "../lib/paths";

export const GET: APIRoute = () => {
  const body = `# tubeless

> Dependency-free TypeScript primitives for typed, observable data pipelines and their CLI programs.

Human site: ${absUrl()}
Package source: ${GITHUB_BLOB}

Start:

- First pipeline: ${absUrl("start")}
- Getting started: ${absUrl("docs/getting-started")}
- CLI: ${absUrl("docs/cli")}
- Local studio: ${absUrl("docs/studio")}
- Choose a pattern: ${absUrl("docs/recipes")}
- Execution semantics: ${absUrl("docs/concepts")}
- Comparison: ${absUrl("docs/comparison")}

Agent instructions:

- This map: ${absUrl("llms.txt")}
- Agent entrypoints: ${absUrl("agents")}
- Canonical guide: ${absUrl("docs/agent-guide")}
- Raw guide: ${githubRaw("docs/agent-guide.md")}
- Skill: ${GITHUB_BLOB}/skills/tubeless/SKILL.md
- Project catalog: ${GITHUB_BLOB}/examples/catalog/tubeless.studio.ts
- Maintain stable step IDs.
- Use optional step names only as display overrides; dependencies and selection use IDs.
- Use pipeline.toMermaid() to generate static graph documentation.
- Use tubeless inspect with a pipeline or marked command module for a read-only inventory of identity plus the default plan. Prefer the marked command when both are exported.
- Use tubeless plan with a pipeline or marked command module to preview target, exact-step, and dry-run selection without executing or supplying domain options. Prefer the marked command when both are exported. Use command.plan() or tubeless plan; do not simulate planning with --plan.
- Use tubeless graph with a pipeline or marked command module to print Mermaid without a wrapper script. Prefer the marked command when both are exported.
- Use tubeless run only with a definePipelineCommand module; put the command's validated application arguments after --.
- Set dryRun: "skip" on external side effects, or provide a side-effect-free dryRun handler.
- Use context.log, context.signal, context.sleep, and progress APIs.
- Use createPipelineTestRuntime from tubeless/testing for deterministic tests.
- Use definePipelineCommand for pipeline-backed scripts.
- Declare public goals with targets: [step] on definePipeline. stepIds is an exact filter and cannot be combined with targets.
- Use PipelinePlanStep.selectionReasons for selection explanations.
- Branch on PipelineError code/phase/kind, not message text.
- Use requireOutputs for finalizers that need specific completed step outputs.
- Core imports no schema library.

Advanced:

- Child pipelines: ${absUrl("docs/child-pipeline-composition")}
- Public exports: ${absUrl("docs/api-reference")}
- Machine-readable surface: ${absUrl("api-report.json")}
- Agent evaluation cases: ${absUrl("docs/agent-evaluations")}

Executable examples:

- ${GITHUB_BLOB}/examples/catalog/tubeless.studio.ts
- ${GITHUB_BLOB}/examples/typed-import.ts
- ${GITHUB_BLOB}/examples/validated-boundaries.ts
- ${GITHUB_BLOB}/examples/publish-with-gates.ts
- ${GITHUB_BLOB}/examples/conditional-step.ts
- ${GITHUB_BLOB}/examples/best-effort.ts
- ${GITHUB_BLOB}/examples/child-pipeline.ts
- ${GITHUB_BLOB}/examples/fan-out-progress.ts
- ${GITHUB_BLOB}/examples/resumable-enrichment.ts
- ${GITHUB_BLOB}/examples/cli-job.ts
- ${GITHUB_BLOB}/examples/rendering.ts
- ${GITHUB_BLOB}/examples/cancellation-and-testing.ts
- ${GITHUB_BLOB}/examples/live-tui.ts
- ${GITHUB_BLOB}/examples/peloton.ts
- ${GITHUB_BLOB}/examples/tracing.ts
- ${GITHUB_BLOB}/examples/local-observability.ts
`;

  return new Response(body, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=300",
    },
  });
};
