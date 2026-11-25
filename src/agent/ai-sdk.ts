import {
  generateText,
  isStepCount,
  jsonSchema,
  modelMessageSchema,
  tool,
  type AssistantModelMessage,
  type LanguageModel,
  type LanguageModelUsage,
  type ToolCallPart,
  type ToolModelMessage,
} from "ai";
import type { AgentDecisionContext } from "./agent-types.js";
import type { AgentModel, AgentModelDescriptors, AgentModelRequest } from "./model-types.js";
import { DEFAULT_MAX_RETRIES, MAX_REQUEST_BYTES, validProviderLimits } from "./provider-limits.js";
import { withProviderDeadline } from "./provider-http.js";
import { record, strictParameter, type StrictSchemaRules } from "./provider-schema.js";
import { boundedToolOutputs } from "./provider-tool-outputs.js";
import { utf8ByteLength } from "./provider-utf8.js";
import { agentTranscript } from "./transcript.js";
import { awaitWithAbort, throwIfAborted } from "../utilities/abort.js";
import { AGENT_MODEL_ATTRIBUTES, AGENT_TRACE_ATTRIBUTES } from "../tracing/agent-telemetry.js";
import type { PipelineTraceAttributes } from "../tracing/tracing-contracts.js";

const TOOL_RULE =
  "Respond only by calling tools. Call _finish alone with the final answer. Never mix _finish with tool calls.";
type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
const REASONING_EFFORTS = new Set<string>([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] satisfies ReasoningEffort[]);
const SCHEMA_RULES: StrictSchemaRules = {
  provider: "AI SDK",
  closedObjects: false,
  requireEveryProperty: false,
};

/** A Vercel AI SDK language model: a gateway model id, or any v2, v3, or v4 model object. */
export type AiSdkLanguageModel =
  | string
  | {
      readonly specificationVersion: "v2" | "v3" | "v4";
      readonly provider: string;
      readonly modelId: string;
      doGenerate(options: unknown): PromiseLike<{ readonly content: readonly unknown[] }>;
    };

/** Settings for {@link aiSdkModel}. Install the optional `ai` package before importing this entry. */
export interface AiSdkModelOptions {
  /** An AI SDK language model, or a gateway id such as `openai/gpt-5.4-mini`. Strings make a network request. */
  readonly model: AiSdkLanguageModel;
  /** AI SDK 7 `reasoning` value. Omitted by default; null also omits it. */
  readonly reasoningEffort?: ReasoningEffort | null;
  /** Maximum output tokens for one decision request. Defaults to 8192. */
  readonly maxOutputTokens?: number;
  /** Deadline for one decision, including the reminder. Defaults to 60000 ms and fails the run. */
  readonly timeoutMs?: number;
  /** AI SDK retries for one decision request. Defaults to 2; 0 disables them. */
  readonly maxRetries?: number;
}

type StoredMessage =
  | { readonly role: "user"; readonly content: string }
  | AssistantModelMessage
  | ToolModelMessage;
type ToolCalls = Awaited<ReturnType<typeof generateText>>["toolCalls"];

/** Run any Vercel AI SDK language model, including its tool calls and structured final answer. */
export function aiSdkModel(options: AiSdkModelOptions): AgentModel {
  const model = options?.model;
  const reasoningEffort = options?.reasoningEffort ?? null;
  const maxOutputTokens = options?.maxOutputTokens ?? 8192;
  const timeoutMs = options?.timeoutMs ?? 60_000;
  const maxRetries = options?.maxRetries ?? DEFAULT_MAX_RETRIES;
  if (
    options === null ||
    typeof options !== "object" ||
    !validLanguageModel(model) ||
    !validReasoning(reasoningEffort) ||
    typeof maxOutputTokens !== "number" ||
    !validTokenLimit(maxOutputTokens) ||
    typeof timeoutMs !== "number" ||
    typeof maxRetries !== "number" ||
    !validProviderLimits(timeoutMs, maxRetries, null)
  )
    throw new Error("Invalid AI SDK model configuration");
  const selected = model;
  const identity = modelIdentity(selected);
  const decide: AgentModel = async (request, context) =>
    withProviderDeadline("AI SDK decision", timeoutMs, context.signal, async (signal) => {
      throwIfAborted(signal, "AI SDK decision");
      const prepared = prepareRequest(request, context);
      let messages = prepared.messages;
      const report = decisionReporter(identity, context);
      for (let attempt = 0, requestIndex = 0; ; attempt += 1) {
        throwIfAborted(signal, "AI SDK decision");
        if (utf8ByteLength(JSON.stringify(messages)) + prepared.overhead > MAX_REQUEST_BYTES)
          throw new Error("AI SDK request exceeds 1 MiB");
        requestIndex += 1;
        const currentMessages = messages;
        const result = await report(requestIndex, () =>
          awaitWithAbort(
            generateText({
              // The public declaration deliberately uses a peer-free structural model type.
              model: selected as LanguageModel,
              instructions: prepared.system,
              messages: currentMessages,
              tools: prepared.tools,
              toolChoice: "auto",
              stopWhen: isStepCount(1),
              maxOutputTokens,
              maxRetries,
              abortSignal: signal,
              telemetry: { isEnabled: false },
              reasoning: reasoningEffort ?? undefined,
            }),
            signal,
            "AI SDK decision"
          )
        );
        throwIfAborted(signal, "AI SDK decision");
        recordAssistantText(result.text, context);
        assertUsableFinish(result.finishReason);
        // The SDK preserves part order and translates providerMetadata to providerOptions.
        const response = result.response.messages;
        if (response.length === 0) throw new Error("AI SDK model returned empty content");
        messages = [...messages, ...response];
        const decision = decisionFrom(result.toolCalls);
        if (decision?.kind === "finish") messages = closeFinished(messages);
        if (decision) return { decision, conversation: messages };
        if (attempt > 0) throw new Error("AI SDK model returned no tool calls");
        messages = appendUser(messages, TOOL_RULE);
      }
    });
  return Object.assign(decide, {
    checkDescriptors: (descriptors: AgentModelDescriptors) => void aiSdkTools(descriptors),
  });
}

function validLanguageModel(model: unknown): model is AiSdkLanguageModel {
  if (typeof model === "string") return model.trim().length > 0;
  if (!record(model)) return false;
  const version = model.specificationVersion;
  return (
    (version === "v2" || version === "v3" || version === "v4") &&
    typeof model.provider === "string" &&
    model.provider.trim().length > 0 &&
    typeof model.modelId === "string" &&
    model.modelId.trim().length > 0 &&
    typeof model.doGenerate === "function"
  );
}

function validReasoning(value: unknown): boolean {
  return value === null || (typeof value === "string" && REASONING_EFFORTS.has(value));
}

function validTokenLimit(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1 && value <= 2_147_483_647;
}

function modelIdentity(model: AiSdkLanguageModel): { provider: string; name: string } {
  if (typeof model === "string") return { provider: "ai-sdk", name: model.trim() };
  return { provider: model.provider.trim(), name: model.modelId.trim() };
}

function prepareRequest(request: AgentModelRequest, context: AgentDecisionContext<object>) {
  const built = aiSdkTools(context);
  const system = `${request.instructions}\n\n${TOOL_RULE}`;
  // Reserve room for the one reminder sent when a response contains no tool call.
  const overhead = utf8ByteLength(system) + built.schemaBytes + utf8ByteLength(TOOL_RULE) + 64;
  return {
    system,
    tools: built.tools,
    overhead,
    messages: history(request, context.turn, overhead),
  };
}

function aiSdkTools(descriptors: AgentModelDescriptors) {
  const specs = [
    ...descriptors.capabilities.map((capability) => ({
      name: capability.name,
      description: capability.description,
      parameters: strictParameter(
        "input",
        capability.inputJsonSchema,
        capability.name,
        SCHEMA_RULES
      ),
    })),
    {
      name: "_finish",
      description: "Finish the task. Call this tool alone with the final answer.",
      parameters: strictParameter("result", descriptors.resultJsonSchema, "_finish", SCHEMA_RULES),
    },
  ];
  return {
    schemaBytes: utf8ByteLength(JSON.stringify(specs)),
    tools: Object.fromEntries(
      specs.map((spec) => [
        spec.name,
        tool({ description: spec.description, inputSchema: jsonSchema(spec.parameters) }),
      ])
    ),
  };
}

function history(request: AgentModelRequest, turn: number, overhead: number): StoredMessage[] {
  const newPrompt = turn === 1 && request.outcomes.length === 0;
  let messages = request.conversation === null ? [] : cloneConversation(request.conversation);
  if (newPrompt && request.conversation !== null) messages = closeFinished(messages);
  if (request.conversation === null || newPrompt) messages = appendUser(messages, request.task);
  const withOutputs = (budget: number) =>
    request.outcomes.length === 0 ? messages : [...messages, toolResults(request.outcomes, budget)];
  const full = withOutputs(MAX_REQUEST_BYTES);
  if (utf8ByteLength(JSON.stringify(full)) + overhead <= MAX_REQUEST_BYTES) return full;
  const room = MAX_REQUEST_BYTES - overhead - utf8ByteLength(JSON.stringify(messages)) - 32;
  const shrunk = withOutputs(room);
  if (utf8ByteLength(JSON.stringify(shrunk)) + overhead > MAX_REQUEST_BYTES)
    throw new Error("AI SDK request exceeds 1 MiB");
  return shrunk;
}

function toolResults(outcomes: AgentModelRequest["outcomes"], budget: number): ToolModelMessage {
  return {
    role: "tool",
    content: boundedToolOutputs("AI SDK", outcomes, budget, (outcome, output) => ({
      type: "tool-result" as const,
      toolCallId: outcome.id,
      toolName: outcome.tool,
      output: outcome.ok
        ? { type: "text" as const, value: output }
        : { type: "error-text" as const, value: output },
    })),
  };
}

function decisionReporter(
  identity: { provider: string; name: string },
  context: Pick<AgentDecisionContext<object>, "reportAttempt" | "turn">
) {
  return async <T extends { readonly usage: LanguageModelUsage }>(
    index: number,
    send: () => Promise<T>
  ): Promise<T> => {
    const started = performance.now();
    let attributes: PipelineTraceAttributes = {};
    let received = false;
    try {
      const result = await send();
      received = true;
      attributes = usageAttributes(result.usage);
      return result;
    } finally {
      context.reportAttempt(1, {
        ...attributes,
        [AGENT_MODEL_ATTRIBUTES.provider]: identity.provider,
        [AGENT_MODEL_ATTRIBUTES.name]: identity.name,
        [AGENT_MODEL_ATTRIBUTES.operation]: "decision",
        [AGENT_MODEL_ATTRIBUTES.request]: index,
        [AGENT_MODEL_ATTRIBUTES.responseReceived]: received,
        [AGENT_MODEL_ATTRIBUTES.durationMs]: performance.now() - started,
        [AGENT_TRACE_ATTRIBUTES.turn]: context.turn,
      });
    }
  };
}

function usageAttributes(usage: LanguageModelUsage): PipelineTraceAttributes {
  const { inputTokenDetails: input, outputTokenDetails: output } = usage;
  const attributes: Record<string, number> = {};
  assignCount(attributes, AGENT_MODEL_ATTRIBUTES.inputTokens, usage.inputTokens);
  assignCount(attributes, AGENT_MODEL_ATTRIBUTES.outputTokens, usage.outputTokens);
  assignCount(attributes, AGENT_MODEL_ATTRIBUTES.uncachedInputTokens, input.noCacheTokens);
  assignCount(attributes, AGENT_MODEL_ATTRIBUTES.cacheReadTokens, input.cacheReadTokens);
  assignCount(attributes, AGENT_MODEL_ATTRIBUTES.cacheWriteTokens, input.cacheWriteTokens);
  assignCount(attributes, AGENT_MODEL_ATTRIBUTES.reasoningTokens, output.reasoningTokens);
  return attributes;
}

function assignCount(target: Record<string, number>, key: string, value: unknown): void {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) target[key] = value;
}

function assertUsableFinish(reason: string): void {
  // Providers map unrecognized raw reasons (e.g. OpenAI-compatible "eos") to "other".
  if (reason === "stop" || reason === "tool-calls" || reason === "other") return;
  if (reason === "length")
    throw new Error("AI SDK response reached maxOutputTokens; raise maxOutputTokens");
  if (reason === "content-filter")
    throw new Error("AI SDK model stopped because of a content filter");
  if (reason === "error") throw new Error("AI SDK model stopped because of an error");
  if (reason === "interrupted") throw new Error("AI SDK model response was interrupted");
  throw new Error(`AI SDK model stopped with finish reason ${reason}`);
}

function decisionFrom(calls: ToolCalls) {
  const parsed = calls
    .filter((call) => !call.providerExecuted)
    .map((call) => {
      if (call.invalid)
        throw new Error(`Invalid AI SDK tool call: ${call.toolName}`, { cause: call.error });
      return {
        id: call.toolCallId,
        tool: call.toolName,
        input: unwrap(call.input, call.toolName === "_finish" ? "result" : "input"),
      };
    });
  if (parsed.length === 0) return undefined;
  if (parsed.some((call) => call.tool === "_finish")) {
    if (parsed.length !== 1) throw new Error("AI SDK model must finish without other calls");
    return { kind: "finish" as const, result: parsed[0].input };
  }
  return { kind: "continue" as const, calls: parsed };
}

function unwrap(value: unknown, key: string): unknown {
  if (!record(value) || Object.keys(value).length !== 1 || !Object.hasOwn(value, key))
    throw new Error(`AI SDK tool arguments require exactly one ${key} field`);
  return value[key];
}

function recordAssistantText(text: string, context: AgentDecisionContext<object>): void {
  if (text) void agentTranscript(context)?.record(context.turn, { kind: "assistant", text });
}

function closeFinished(messages: readonly StoredMessage[]): StoredMessage[] {
  const last = messages.at(-1);
  if (last?.role !== "assistant" || typeof last.content === "string") return [...messages];
  const calls = last.content.filter(
    (part): part is ToolCallPart => part.type === "tool-call" && !part.providerExecuted
  );
  if (calls.length === 0) return [...messages];
  if (calls.some((call) => call.toolName !== "_finish"))
    throw new Error("AI SDK conversation has unfinished tool calls");
  return [
    ...messages,
    {
      role: "tool",
      content: calls.map((call) => ({
        type: "tool-result" as const,
        toolCallId: call.toolCallId,
        toolName: "_finish",
        output: { type: "text" as const, value: JSON.stringify(unwrap(call.input, "result")) },
      })),
    },
  ];
}

function appendUser(messages: readonly StoredMessage[], text: string): StoredMessage[] {
  const last = messages.at(-1);
  if (last?.role === "user")
    return [...messages.slice(0, -1), { role: "user", content: `${last.content}\n\n${text}` }];
  return [...messages, { role: "user", content: text }];
}

function cloneConversation(conversation: unknown): StoredMessage[] {
  if (!Array.isArray(conversation) || conversation.length === 0)
    throw new Error("Invalid AI SDK conversation state");
  return conversation.map((value: unknown) => {
    const parsed = modelMessageSchema.safeParse(value);
    if (parsed.success) {
      const message = parsed.data;
      if (message.role === "user" && typeof message.content === "string")
        return { role: "user", content: message.content };
      if (message.role === "assistant" || message.role === "tool") return message;
    }
    throw new Error("Invalid AI SDK conversation state");
  });
}
