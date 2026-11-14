import { resolve } from "node:path";
import type { PipelineContext } from "tubeless";
import { defineAgentLoop, type AgentTranscriptOptions } from "tubeless/agent";
import { openNdjsonAgentTranscriptWriter } from "tubeless/agent/node";
import { textAnswer, textOptions, textTools } from "./agent.js";

/** The caller chooses a private destination; importing the recipe performs no file I/O. */
export function createTranscriptAgent(transcript: AgentTranscriptOptions) {
  return defineAgentLoop({
    id: "transcript-agent",
    name: "Transcript agent",
    description: "Capture a credential-free tool call and answer in an explicit transcript sink.",
    inputSchema: textOptions,
    resultSchema: textAnswer,
    defaultTools: [],
    tools: { uppercase: textTools.uppercase },
    transcript,
    initialState: () => "",
    decide: (state, context) =>
      context.turn === 1
        ? {
            kind: "continue",
            calls: [{ id: "uppercase", tool: "uppercase", input: context.options.question }],
          }
        : { kind: "finish", result: state },
    reduce: (_state, outcomes) =>
      outcomes.map((outcome) => (outcome.ok ? outcome.value : outcome.error.code)).join("; "),
  });
}

/** Append bounded records to application-owned NDJSON, separately from --trace and --store. */
export async function runTranscriptExample(
  destination: string,
  question = "hello",
  context: Partial<PipelineContext> = {}
) {
  const writer = await openNdjsonAgentTranscriptWriter(
    resolve(context.cwd ?? process.cwd(), destination)
  );
  try {
    const agent = createTranscriptAgent({
      write: writer.write,
      // Drop raw proposals; keep validated tool inputs/outcomes and completion.
      redact: (event) => (event.kind === "decision" ? null : event),
    });
    return await agent.runOrThrow({ question }, undefined, context);
  } finally {
    await writer.close();
  }
}
