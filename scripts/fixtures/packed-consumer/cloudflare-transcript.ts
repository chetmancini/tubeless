import {
  createCloudflareAgentTranscriptWriter,
  type CloudflareTranscriptIngest,
} from "tubeless/cloudflare/transcript";

const studio: CloudflareTranscriptIngest = { appendTranscript: async () => ({ accepted: true }) };
const writer = createCloudflareAgentTranscriptWriter(() => studio);
await writer.write({
  version: 1,
  agentId: "agent",
  runId: "run",
  sequence: 1,
  timestamp: 1,
  turn: 0,
  dryRun: false,
  event: { kind: "end", status: "completed" },
});
