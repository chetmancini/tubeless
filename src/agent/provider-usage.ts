import { AGENT_MODEL_ATTRIBUTES, AGENT_TRACE_ATTRIBUTES } from "../tracing/agent-telemetry.js";
import type { AgentDecisionContext } from "./agent-types.js";
import type { PipelineTraceAttributes } from "../tracing/tracing-contracts.js";
import { ProviderRequestError } from "./provider-http.js";
import { record } from "./provider-schema.js";

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function sum(values: readonly unknown[]): number | undefined {
  if (!values.length) return undefined;
  let total = 0;
  for (const value of values) {
    const tokens = count(value);
    if (tokens === undefined) return undefined;
    total += tokens;
  }
  return count(total);
}

function optionalSum(values: readonly unknown[]): number | undefined {
  return sum(values.filter((value) => value !== undefined));
}

/** Allowlisted numeric usage only; provider responses may contain private application data. */
function usageAttributes(provider: "openai" | "anthropic", body: unknown): PipelineTraceAttributes {
  if (!record(body) || !record(body.usage)) return {};
  const usage = body.usage;
  if (provider === "openai") {
    const input = record(usage.input_tokens_details) ? usage.input_tokens_details : {};
    const writes = record(input.cache_write_tokens_details) ? input.cache_write_tokens_details : {};
    const output = record(usage.output_tokens_details) ? usage.output_tokens_details : {};
    return {
      [AGENT_MODEL_ATTRIBUTES.inputTokens]: count(usage.input_tokens),
      [AGENT_MODEL_ATTRIBUTES.outputTokens]: count(usage.output_tokens),
      [AGENT_MODEL_ATTRIBUTES.cacheReadTokens]: count(input.cached_tokens),
      [AGENT_MODEL_ATTRIBUTES.cacheWriteTokens]: count(input.cache_write_tokens),
      [AGENT_MODEL_ATTRIBUTES.cacheWrite30mTokens]: count(writes.ttl_30m_tokens),
      [AGENT_MODEL_ATTRIBUTES.cacheWrite12hTokens]: count(writes.ttl_12h_tokens),
      [AGENT_MODEL_ATTRIBUTES.reasoningTokens]: count(output.reasoning_tokens),
    };
  }
  // Compaction is billed in iterations; top-level counters exclude those calls.
  if (
    usage.iterations !== undefined &&
    (!Array.isArray(usage.iterations) || !usage.iterations.every(record))
  )
    return {};
  const entries: readonly Record<string, unknown>[] = [
    usage,
    ...(Array.isArray(usage.iterations) ? usage.iterations : []),
  ];
  const uncached = sum(entries.map((entry) => entry.input_tokens));
  const reads = optionalSum(entries.map((entry) => entry.cache_read_input_tokens));
  const writes = optionalSum(entries.map((entry) => entry.cache_creation_input_tokens));
  return {
    [AGENT_MODEL_ATTRIBUTES.inputTokens]: sum(
      entries.flatMap((entry) => [
        entry.input_tokens,
        entry.cache_read_input_tokens === undefined ? 0 : entry.cache_read_input_tokens,
        entry.cache_creation_input_tokens === undefined ? 0 : entry.cache_creation_input_tokens,
      ])
    ),
    [AGENT_MODEL_ATTRIBUTES.uncachedInputTokens]: uncached,
    [AGENT_MODEL_ATTRIBUTES.outputTokens]: sum(entries.map((entry) => entry.output_tokens)),
    [AGENT_MODEL_ATTRIBUTES.cacheReadTokens]: reads,
    [AGENT_MODEL_ATTRIBUTES.cacheWriteTokens]: writes,
    [AGENT_MODEL_ATTRIBUTES.cacheWrite5mTokens]: optionalSum(
      entries.map((entry) =>
        record(entry.cache_creation)
          ? entry.cache_creation.ephemeral_5m_input_tokens
          : entry.cache_creation === undefined
            ? undefined
            : null
      )
    ),
    [AGENT_MODEL_ATTRIBUTES.cacheWrite1hTokens]: optionalSum(
      entries.map((entry) =>
        record(entry.cache_creation)
          ? entry.cache_creation.ephemeral_1h_input_tokens
          : entry.cache_creation === undefined
            ? undefined
            : null
      )
    ),
  };
}

export function modelRequestReporter(
  provider: "openai" | "anthropic",
  model: string,
  context: Pick<AgentDecisionContext<object>, "reportAttempt" | "turn">
) {
  let request = 0;
  return async (operation: "decision" | "compaction", send: () => Promise<unknown>) => {
    const index = ++request;
    const started = performance.now();
    let attributes: PipelineTraceAttributes = {};
    let received = false;
    try {
      const body = await send();
      received = true;
      attributes = usageAttributes(provider, body);
      return body;
    } catch (error) {
      if (error instanceof ProviderRequestError && error.status !== undefined)
        attributes = { [AGENT_MODEL_ATTRIBUTES.httpStatus]: error.status };
      throw error;
    } finally {
      context.reportAttempt(1, {
        ...attributes,
        [AGENT_MODEL_ATTRIBUTES.provider]: provider,
        [AGENT_MODEL_ATTRIBUTES.name]: model,
        [AGENT_MODEL_ATTRIBUTES.operation]: operation,
        [AGENT_MODEL_ATTRIBUTES.request]: index,
        [AGENT_MODEL_ATTRIBUTES.responseReceived]: received,
        [AGENT_MODEL_ATTRIBUTES.durationMs]: performance.now() - started,
        [AGENT_TRACE_ATTRIBUTES.turn]: context.turn,
      });
    }
  };
}
