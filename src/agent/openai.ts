import type { AgentModel, AgentModelDescriptors } from "./model-types.js";
import { openaiRequest } from "./openai-http.js";
import {
  DEFAULT_COMPACT_AFTER_BYTES,
  DEFAULT_MAX_RETRIES,
  MAX_REQUEST_BYTES,
  MAX_RETRIES_LIMIT,
  providerBaseUrl,
  withProviderDeadline,
  withProviderRetry,
} from "./provider-http.js";
import { record } from "./provider-schema.js";
import { openaiDecision, outputItems, parameter } from "./openai-protocol.js";
import { boundedToolOutputs } from "./provider-tool-outputs.js";
import { modelRequestReporter } from "./provider-usage.js";
import { throwIfAborted } from "../utilities/abort.js";
import { agentTranscript } from "./transcript.js";

/** Responses transport settings; credentials are resolved only when a decision executes. */
export interface OpenAIModelOptions {
  /** Defaults to OPENAI_MODEL or gpt-5.4-mini. Must support Responses function calling and compaction. */
  readonly model?: string;
  /** Defaults to OPENAI_API_KEY at execution time. */
  readonly apiKey?: string;
  /**
   * Responses API root, including the version path. Defaults to OPENAI_BASE_URL or
   * https://api.openai.com/v1; set it for any server that implements the Responses API.
   */
  readonly baseUrl?: string;
  /** Omitted by default. Set explicitly for models that support reasoning; null also omits it. */
  readonly reasoningEffort?:
    | "none"
    | "minimal"
    | "low"
    | "medium"
    | "high"
    | "xhigh"
    | "max"
    | null;
  /**
   * Compact above this history size (default 786432 bytes), or when the complete decision
   * exceeds the request limit. null never calls /responses/compact, for servers without it.
   */
  readonly compactAfterBytes?: number | null;
  /**
   * Combined deadline for compaction and decision requests; defaults to 60000 ms.
   * Reaching it fails the decision rather than cancelling the run.
   */
  readonly timeoutMs?: number;
  /**
   * Extra attempts for each HTTP request after a rate limit (429), timeout (408), server
   * error (5xx) or network failure. Defaults to 2; 0 disables. Waits honor Retry-After,
   * stay inside `timeoutMs`, and do not consume harness decision admissions.
   */
  readonly maxRetries?: number;
}

/** Create a dependency-free OpenAI Responses model with native history and automatic compaction. */
export function openaiModel(options: OpenAIModelOptions = {}): AgentModel {
  const {
    model,
    apiKey,
    baseUrl,
    reasoningEffort = null,
    compactAfterBytes = DEFAULT_COMPACT_AFTER_BYTES,
    timeoutMs = 60_000,
    maxRetries = DEFAULT_MAX_RETRIES,
  } = options;
  if (
    (compactAfterBytes !== null &&
      (!Number.isSafeInteger(compactAfterBytes) ||
        compactAfterBytes < 1 ||
        compactAfterBytes >= MAX_REQUEST_BYTES)) ||
    (baseUrl !== undefined && typeof baseUrl !== "string") ||
    !Number.isSafeInteger(maxRetries) ||
    maxRetries < 0 ||
    maxRetries > MAX_RETRIES_LIMIT ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 2_147_483_647 ||
    (model !== undefined && (typeof model !== "string" || !model.trim())) ||
    (apiKey !== undefined && (typeof apiKey !== "string" || !apiKey.trim())) ||
    (reasoningEffort !== null &&
      !["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(reasoningEffort))
  )
    throw new Error("Invalid OpenAI model configuration");
  if (baseUrl !== undefined) providerBaseUrl("OpenAI", baseUrl);
  const decide: AgentModel = async (request, context) => {
    const selectedModel = (model ?? process.env.OPENAI_MODEL)?.trim() || "gpt-5.4-mini";
    return withProviderDeadline(
      "OpenAI decision",
      timeoutMs,
      context.signal,
      async (signal, remainingMs) => {
        throwIfAborted(signal, "OpenAI decision");
        // Validate descriptors before either compaction or a decision can perform I/O.
        const tools = openaiTools(context);
        const reportRequest = modelRequestReporter("openai", selectedModel, context);
        // Retry wraps the reporter, so every HTTP attempt is its own trace event.
        const send = (
          operation: "decision" | "compaction",
          endpoint: "responses" | "responses/compact",
          payload: object
        ) =>
          withProviderRetry(
            {
              maxRetries,
              signal,
              remainingMs,
              label: `OpenAI ${operation}`,
              log: (message) => context.log.warn(message),
            },
            () =>
              reportRequest(operation, () =>
                openaiRequest(endpoint, payload, apiKey, signal, baseUrl)
              )
          );
        if (
          request.conversation !== null &&
          (!Array.isArray(request.conversation) || !request.conversation.every(record))
        )
          throw new Error("Invalid OpenAI conversation state");
        const newPrompt = context.turn === 1 && request.outcomes.length === 0;
        let input: unknown[] = request.conversation === null ? [] : [...request.conversation];
        if (request.conversation === null || newPrompt)
          input.push({ role: "user", content: request.task });
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
        const completedInput = [
          ...input,
          ...boundedToolOutputs(
            "OpenAI",
            request.outcomes,
            MAX_REQUEST_BYTES,
            (outcome, output) => ({
              type: "function_call_output" as const,
              call_id: outcome.id,
              output,
            })
          ),
        ];
        const shouldCompact =
          compactAfterBytes !== null &&
          (request.outcomes.length > 0 || (newPrompt && request.conversation !== null)) &&
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
                ...boundedToolOutputs(
                  "OpenAI",
                  request.outcomes,
                  MAX_REQUEST_BYTES - Buffer.byteLength(JSON.stringify(nextRequest)),
                  (outcome, output) => ({
                    type: "function_call_output" as const,
                    call_id: outcome.id,
                    output,
                  })
                ),
              ];
        if (shouldCompact) {
          // Keep the new user request verbatim, outside the completed history window.
          if (newPrompt) input = input.slice(0, -1);
          const compacted = await send("compaction", "responses/compact", {
            ...compactRequest,
            input,
          });
          if (!record(compacted) || compacted.object !== "response.compaction")
            throw new Error("OpenAI returned invalid compaction");
          input = outputItems(compacted);
          if (input.length === 0) throw new Error("OpenAI returned empty compaction");
          if (newPrompt) input.push({ role: "user", content: request.task });
          context.log.log("Compacted agent conversation");
          // Queue provider observations; the harness drains them outside the request deadline.
          void agentTranscript(context)?.record(context.turn, {
            kind: "compaction",
            provider: "openai",
          });
        }
        const body = await send("decision", "responses", { ...decisionRequest, input });
        if (!record(body)) throw new Error("OpenAI did not return a completed response");
        const output = outputItems(body);
        const transcript = agentTranscript(context);
        if (transcript)
          for (const item of output)
            if (item.type === "message" && Array.isArray(item.content))
              for (const part of item.content)
                if (record(part) && part.type === "output_text" && typeof part.text === "string")
                  void transcript.record(context.turn, { kind: "assistant", text: part.text });
        if (body.status !== "completed")
          throw new Error("OpenAI did not return a completed response");
        const decision = openaiDecision(output);
        const conversation = [...input, ...output];
        // A completed user prompt may be continued later. Close the adapter's
        // synthetic tool call before another user message enters native history.
        const finish = output.find(
          (item) => item.type === "function_call" && item.name === "_finish"
        );
        if (finish)
          conversation.push({
            type: "function_call_output",
            call_id: finish.call_id,
            output: JSON.stringify(decision.result),
          });
        return { decision, conversation };
      }
    );
  };
  return Object.assign(decide, {
    checkDescriptors: (descriptors: AgentModelDescriptors) => void openaiTools(descriptors),
  });
}

/** Strict function tools for these descriptors, plus the adapter-only `_finish` function. */
function openaiTools({ capabilities, resultJsonSchema }: AgentModelDescriptors) {
  return [
    ...capabilities.map((tool) => ({
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
      parameters: parameter("result", resultJsonSchema, "tool _finish"),
      strict: true,
    },
  ];
}
