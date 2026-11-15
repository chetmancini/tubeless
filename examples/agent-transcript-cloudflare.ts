import { defineAgentLoop } from "tubeless/agent";
import {
  createCloudflareAgentTranscriptWriter,
  type CloudflareTranscriptIngest,
} from "tubeless/cloudflare/transcript";
import { textAnswer, textOptions, textTools } from "./agent.js";

/** Register the returned agent in the Worker project; the getter retains its private binding. */
export function createCloudflareTranscriptAgent(studio: () => CloudflareTranscriptIngest) {
  return defineAgentLoop({
    id: "cloudflare-transcript-agent",
    inputSchema: textOptions,
    resultSchema: textAnswer,
    defaultTools: [],
    tools: { uppercase: textTools.uppercase },
    transcript: {
      ...createCloudflareAgentTranscriptWriter(studio),
      // Omit proposals while retaining validated calls, results and completion.
      redact: (event) => (event.kind === "decision" ? null : event),
    },
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
