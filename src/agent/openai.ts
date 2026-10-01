import type { AgentModel } from "./model-types.js";
import { MAX_REQUEST_BYTES, openaiRequest } from "./openai-http.js";
import { openaiDecision, outputItems, parameter, record } from "./openai-protocol.js";
import { openaiToolOutputs } from "./openai-tool-outputs.js";
import { throwIfAborted } from "../utilities/abort.js";

/** Responses transport settings; credentials are resolved only when a decision executes. */
export interface OpenAIModelOptions {
  /** Defaults to OPENAI_MODEL or gpt-5.4-mini. Must support Responses function calling and compaction. */
  readonly model?: string;
  /** Defaults to OPENAI_API_KEY at execution time. */
  readonly apiKey?: string;
  /** Omitted by default. Set explicitly for models that support reasoning; null also omits it. */
  readonly reasoningEffort?: "none" | "low" | "medium" | "high" | "xhigh" | null;
  /** Compact above this history size (default 65536 bytes), or when the complete decision exceeds the request limit. */
  readonly compactAfterBytes?: number;
  /** Combined deadline for compaction and decision requests; defaults to 60000 ms. */
  readonly timeoutMs?: number;
}

/** Create a dependency-free OpenAI Responses model with native history and automatic compaction. */
export function openaiModel(options: OpenAIModelOptions = {}): AgentModel {
  const {
    model,
    apiKey,
    reasoningEffort = null,
    compactAfterBytes = 65_536,
    timeoutMs = 60_000,
  } = options;
  if (
    !Number.isSafeInteger(compactAfterBytes) ||
    compactAfterBytes < 1 ||
    compactAfterBytes >= MAX_REQUEST_BYTES ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 2_147_483_647 ||
    (model !== undefined && (typeof model !== "string" || !model.trim())) ||
    (apiKey !== undefined && (typeof apiKey !== "string" || !apiKey.trim())) ||
    (reasoningEffort !== null &&
      !["none", "low", "medium", "high", "xhigh"].includes(reasoningEffort))
  )
    throw new Error("Invalid OpenAI model configuration");
  return async (request, context) => {
    const selectedModel = (model ?? process.env.OPENAI_MODEL)?.trim() || "gpt-5.4-mini";
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = context.signal ? AbortSignal.any([context.signal, timeout]) : timeout;
    throwIfAborted(signal, "OpenAI decision");
    // Validate descriptors before either compaction or a decision can perform I/O.
    const tools = [
      ...context.capabilities.map((tool) => ({
        type: "function",
        name: tool.name,
        description: tool.description,
        parameters: parameter("input", tool.inputJsonSchema, `tool ${tool.name}`),
        strict: true,
      })),
      {
        type: "function",
        name: "_finish",
        description: "Finish with the final answer.",
        parameters: parameter("result", context.resultJsonSchema, "tool _finish"),
        strict: true,
      },
    ];
    if (
      request.conversation !== null &&
      (!Array.isArray(request.conversation) || !request.conversation.every(record))
    )
      throw new Error("Invalid OpenAI conversation state");
    let input: unknown[] =
      request.conversation === null
        ? [{ role: "user", content: request.task }]
        : [...request.conversation];
    const compactRequest = { model: selectedModel, instructions: request.instructions, input };
    const decisionRequest = {
      model: selectedModel,
      store: false,
      ...(reasoningEffort === null ? {} : { reasoning: { effort: reasoningEffort } }),
      include: ["reasoning.encrypted_content"],
      max_output_tokens: 8192,
      instructions: `${request.instructions}\n\nCall _finish alone with the final answer. Never mix _finish with tool calls.`,
      input,
      tools,
      tool_choice: "required",
      parallel_tool_calls: true,
    };
    const completedInput = [...input, ...openaiToolOutputs(request.outcomes, MAX_REQUEST_BYTES)];
    const shouldCompact =
      request.outcomes.length > 0 &&
      (Buffer.byteLength(JSON.stringify(completedInput)) > compactAfterBytes ||
        Buffer.byteLength(JSON.stringify({ ...decisionRequest, input: completedInput })) >
          MAX_REQUEST_BYTES);
    // Compaction sends no tool schemas. Budget against the request actually sent,
    // then check the decision with the returned compacted window at the HTTP boundary.
    const nextRequest = shouldCompact ? compactRequest : decisionRequest;
    input =
      Buffer.byteLength(JSON.stringify({ ...nextRequest, input: completedInput })) <=
      MAX_REQUEST_BYTES
        ? completedInput
        : [
            ...input,
            ...openaiToolOutputs(
              request.outcomes,
              MAX_REQUEST_BYTES - Buffer.byteLength(JSON.stringify(nextRequest))
            ),
          ];
    if (shouldCompact) {
      const compacted = await openaiRequest(
        "responses/compact",
        { ...compactRequest, input },
        apiKey,
        signal
      );
      if (!record(compacted) || compacted.object !== "response.compaction")
        throw new Error("OpenAI returned invalid compaction");
      input = outputItems(compacted);
      if (input.length === 0) throw new Error("OpenAI returned empty compaction");
      context.log.log("Compacted agent conversation");
    }
    const body = await openaiRequest("responses", { ...decisionRequest, input }, apiKey, signal);
    if (!record(body) || body.status !== "completed")
      throw new Error("OpenAI did not return a completed response");
    const output = outputItems(body);
    return { decision: openaiDecision(output), conversation: [...input, ...output] };
  };
}
