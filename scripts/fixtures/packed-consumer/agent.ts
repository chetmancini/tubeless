// Type-checked only: never executed.
import { defineAgent, type AgentModel } from "tubeless/agent";
import { anthropicModel } from "tubeless/agent/anthropic";
import { connectMcpServers, type McpServers } from "tubeless/agent/mcp";
import { openaiModel } from "tubeless/agent/openai";
import type { StandardSchemaV1 } from "tubeless";

declare const filesSchema: StandardSchemaV1<{ files: string[] }>;
declare const countSchema: StandardSchemaV1<{ count: number }>;

const openai: AgentModel = openaiModel({ model: "m", apiKey: "k" });
const anthropic: AgentModel = anthropicModel({ model: "m", apiKey: "k" });

const typedAgent = defineAgent({
  id: "packed-typed-agent",
  model: openai,
  inputSchema: filesSchema,
  resultSchema: countSchema,
  task: ({ files }) => files.join("\n"),
});
const counted: Promise<{ count: number }> = typedAgent.runOrThrow({ files: [] });
// @ts-expect-error A typed agent accepts only its declared input.
typedAgent.runOrThrow({ task: "x" });

const defaultAgent = defineAgent({ id: "packed-default-agent", model: anthropic });
const answered: Promise<{ answer: string }> = defaultAgent.runOrThrow({ task: "hello" });

// The MCP entry declares Symbol.asyncDispose, which needs lib ESNext.Disposable.
const connected: Promise<McpServers<"docs">> = connectMcpServers({
  docs: { url: "https://mcp.example.invalid/mcp" },
});
