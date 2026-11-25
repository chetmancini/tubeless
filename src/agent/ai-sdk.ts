import { generateText, jsonSchema, stepCountIs, tool, type LanguageModel } from "ai";
import type { AgentDecisionContext } from "./agent-types.js";
import type { AgentModel, AgentModelDescriptors, AgentModelRequest } from "./model-types.js";
import { DEFAULT_MAX_RETRIES, MAX_REQUEST_BYTES, validProviderLimits } from "./provider-limits.js";
import { withProviderDeadline } from "./provider-http.js";
import { record, strictParameter, type StrictSchemaRules } from "./provider-schema.js";
import { boundedToolOutputs } from "./provider-tool-outputs.js";
import { utf8ByteLength } from "./provider-utf8.js";
import { agentTranscript } from "./transcript.js";
import { throwIfAborted } from "../utilities/abort.js";
import { AGENT_MODEL_ATTRIBUTES, AGENT_TRACE_ATTRIBUTES } from "../tracing/agent-telemetry.js";
import type { PipelineTraceAttributes } from "../tracing/tracing-contracts.js";

const TOOL_RULE =
  "Respond only by calling tools. Call _finish alone with the final answer. Never mix _finish with tool calls.";
type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
const REASONING_EFFORTS = " none minimal low medium high xhigh max ";
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
      doGenerate(options: unknown): unknown;
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

interface TextPart {
  readonly type: "text";
  readonly text: string;
}

interface ToolCallPart {
  readonly type: "tool-call";
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: unknown;
  readonly providerOptions?: Record<string, unknown>;
}

interface ToolResultPart {
  readonly type: "tool-result";
  readonly toolCallId: string;
  readonly toolName: string;
  readonly output: { readonly type: "text" | "error-text"; readonly value: string };
  readonly providerOptions?: Record<string, unknown>;
}

type StoredMessage =
  | { readonly role: "user"; readonly content: string }
  | { readonly role: "assistant"; readonly content: readonly (TextPart | ToolCallPart)[] }
  | { readonly role: "tool"; readonly content: readonly ToolResultPart[] };

interface ListedCall {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: unknown;
  readonly providerOptions?: unknown;
}

interface DecisionGeneration {
  readonly text: string;
  readonly finishReason: string;
  readonly toolCalls: readonly ListedCall[];
}

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
          generateText({
            model: selected as LanguageModel,
            system: prepared.system,
            messages: currentMessages as never,
            tools: prepared.tools,
            toolChoice: "auto",
            stopWhen: stepCountIs(1),
            maxOutputTokens,
            maxRetries,
            abortSignal: signal,
            telemetry: { isEnabled: false },
            ...(reasoningEffort === null ? {} : { reasoning: reasoningEffort }),
          })
        );
        throwIfAborted(signal, "AI SDK decision");
        const generation = generated(result);
        recordAssistantText(generation.text, context);
        assertUsableFinish(generation.finishReason);
        const assistant = assistantMessage(generation.text, generation.toolCalls);
        if (assistant.content.length === 0) throw new Error("AI SDK model returned empty content");
        messages = [...messages, assistant];
        const decision = decisionFrom(generation.toolCalls);
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
  return value === null || (typeof value === "string" && REASONING_EFFORTS.includes(` ${value} `));
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
        tool({ description: spec.description, inputSchema: jsonSchema(spec.parameters as never) }),
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

function toolResults(outcomes: AgentModelRequest["outcomes"], budget: number): StoredMessage {
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
  return async (index: number, send: () => Promise<unknown>) => {
    const started = performance.now();
    let attributes: PipelineTraceAttributes = {};
    let received = false;
    try {
      const result = await send();
      received = true;
      attributes = usageAttributes(result);
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

function usageAttributes(result: unknown): PipelineTraceAttributes {
  if (!record(result) || !record(result.usage)) return {};
  const usage = result.usage;
  const input = record(usage.inputTokenDetails) ? usage.inputTokenDetails : {};
  const output = record(usage.outputTokenDetails) ? usage.outputTokenDetails : {};
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

function generated(result: unknown): DecisionGeneration {
  if (!record(result) || typeof result.text !== "string" || typeof result.finishReason !== "string")
    throw new Error("AI SDK returned an invalid decision");
  if (!Array.isArray(result.toolCalls)) throw new Error("AI SDK returned an invalid decision");
  return {
    text: result.text,
    finishReason: result.finishReason,
    toolCalls: result.toolCalls.map(listedCall),
  };
}

function listedCall(value: unknown): ListedCall {
  if (
    !record(value) ||
    typeof value.toolCallId !== "string" ||
    typeof value.toolName !== "string" ||
    !Object.hasOwn(value, "input")
  )
    throw new Error("Invalid AI SDK tool call");
  const metadata = value.providerMetadata ?? value.providerOptions;
  return {
    toolCallId: value.toolCallId,
    toolName: value.toolName,
    input: value.input,
    ...(metadata === undefined ? {} : { providerOptions: metadata }),
  };
}

function assertUsableFinish(reason: string): void {
  if (reason === "length")
    throw new Error("AI SDK response reached maxOutputTokens; raise maxOutputTokens");
  if (reason === "content-filter")
    throw new Error("AI SDK model stopped because of a content filter");
  if (reason === "error") throw new Error("AI SDK model stopped because of an error");
}

function assistantMessage(text: string, calls: readonly ListedCall[]): StoredMessage {
  const content: (TextPart | ToolCallPart)[] = [];
  if (text) content.push({ type: "text", text });
  for (const call of calls) {
    const providerOptions = jsonRecord(call.providerOptions);
    content.push({
      type: "tool-call",
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      input: call.input,
      ...(providerOptions ? { providerOptions } : {}),
    });
  }
  return { role: "assistant", content };
}

function decisionFrom(calls: readonly ListedCall[]) {
  if (calls.length === 0) return undefined;
  const parsed = calls.map((call) => ({
    id: call.toolCallId,
    tool: call.toolName,
    input: unwrap(call.input, call.toolName === "_finish" ? "result" : "input"),
  }));
  if (parsed.some((call) => call.tool === "_finish")) {
    if (parsed.length !== 1) throw new Error("AI SDK model must finish without other calls");
    return { kind: "finish" as const, result: parsed[0].input };
  }
  return { kind: "continue" as const, calls: parsed };
}

function unwrap(value: unknown, key: string): unknown {
  const parsed = typeof value === "string" ? parseJson(value) : value;
  if (!record(parsed) || Object.keys(parsed).length !== 1 || !Object.hasOwn(parsed, key))
    throw new Error(`AI SDK tool arguments require exactly one ${key} field`);
  return parsed[key];
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error("AI SDK tool arguments must be JSON");
  }
}

function recordAssistantText(text: string, context: AgentDecisionContext<object>): void {
  if (text) void agentTranscript(context)?.record(context.turn, { kind: "assistant", text });
}

function closeFinished(messages: readonly StoredMessage[]): StoredMessage[] {
  const last = messages.at(-1);
  if (last?.role !== "assistant") return [...messages];
  const calls = last.content.filter((part): part is ToolCallPart => part.type === "tool-call");
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
  if (
    !Array.isArray(conversation) ||
    conversation.length === 0 ||
    !conversation.every(isStoredMessage)
  )
    throw new Error("Invalid AI SDK conversation state");
  return conversation.map(cloneMessage);
}

function cloneMessage(message: StoredMessage): StoredMessage {
  if (message.role === "user") return { role: "user", content: message.content };
  if (message.role === "assistant")
    return { role: "assistant", content: message.content.map(cloneAssistantPart) };
  return { role: "tool", content: message.content.map(cloneToolResult) };
}

function cloneAssistantPart(part: TextPart | ToolCallPart): TextPart | ToolCallPart {
  if (part.type === "text") return { type: "text", text: part.text };
  return {
    type: "tool-call",
    toolCallId: part.toolCallId,
    toolName: part.toolName,
    input: part.input,
    ...(part.providerOptions ? { providerOptions: part.providerOptions } : {}),
  };
}

function cloneToolResult(part: ToolResultPart): ToolResultPart {
  return {
    type: "tool-result",
    toolCallId: part.toolCallId,
    toolName: part.toolName,
    output: { type: part.output.type, value: part.output.value },
    ...(part.providerOptions ? { providerOptions: part.providerOptions } : {}),
  };
}

function isStoredMessage(value: unknown): value is StoredMessage {
  if (!record(value)) return false;
  if (value.role === "user") return typeof value.content === "string";
  if (value.role === "assistant")
    return Array.isArray(value.content) && value.content.every(isAssistantPart);
  return (
    value.role === "tool" &&
    Array.isArray(value.content) &&
    value.content.length > 0 &&
    value.content.every(isToolResultPart)
  );
}

function isAssistantPart(value: unknown): value is TextPart | ToolCallPart {
  if (!record(value) || !validOptions(value)) return false;
  if (value.type === "text") return typeof value.text === "string";
  return (
    value.type === "tool-call" &&
    typeof value.toolCallId === "string" &&
    value.toolCallId.trim().length > 0 &&
    typeof value.toolName === "string" &&
    value.toolName.trim().length > 0 &&
    Object.hasOwn(value, "input")
  );
}

function isToolResultPart(value: unknown): value is ToolResultPart {
  if (!record(value) || value.type !== "tool-result" || !validOptions(value)) return false;
  if (typeof value.toolCallId !== "string" || typeof value.toolName !== "string") return false;
  return (
    record(value.output) &&
    (value.output.type === "text" || value.output.type === "error-text") &&
    typeof value.output.value === "string"
  );
}

function validOptions(value: Record<string, unknown>): boolean {
  return value.providerOptions === undefined || record(value.providerOptions);
}

function jsonRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  try {
    const cloned: unknown = JSON.parse(JSON.stringify(value));
    return record(cloned) ? cloned : undefined;
  } catch {
    return undefined;
  }
}
