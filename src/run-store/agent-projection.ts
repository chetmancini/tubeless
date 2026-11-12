import type { PipelineDefinitionSnapshot } from "../core/pipeline-types.js";
import type { PipelineTraceAttributes } from "../tracing/tracing-contracts.js";
import type { StoredPipelineEvent, StoredPipelineRun } from "./run-store.js";

type AgentMetadata = NonNullable<PipelineDefinitionSnapshot["steps"][number]["agent"]>;

export interface StoredAgentDefinition {
  stepId: string;
  limits: AgentMetadata["limits"];
  capabilities: string[];
}

/** Identity of one registered call, scoped to an agent invocation and turn. */
export interface StoredAgentCallMetadata {
  agentRunId: string;
  turn: number;
  callId: string;
  tool: string;
  parentAttemptId: string;
}

export interface StoredAgentTurnMetadata {
  agentRunId: string;
  index: number;
  decision?: "continue" | "finish";
  stateVersion?: number;
  nextStateVersion?: number;
  callCount?: number;
  callsAdmitted?: number;
  calls: StoredAgentCallMetadata[];
  usage?: StoredAgentModelUsage[];
}

/** Counter names equal the `agent.model.<name>` trace attributes. */
export const AGENT_MODEL_COUNTERS = [
  "inputTokens",
  "uncachedInputTokens",
  "outputTokens",
  "reasoningTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "cacheWrite5mTokens",
  "cacheWrite1hTokens",
  "cacheWrite30mTokens",
  "cacheWrite12hTokens",
] as const;
export type AgentModelCounter = (typeof AGENT_MODEL_COUNTERS)[number];

/** Sums for one provider and model. An absent counter was never reported; it is not zero. */
export type StoredAgentModelUsage = {
  provider: string;
  model: string;
  /** Recorded HTTP exchanges: decisions, compactions, reminders and transport failures. */
  requests: number;
  /** Requests recorded without inputTokens or without outputTokens; sums omit their usage. */
  requestsWithoutUsage: number;
  /** Summed request wall time. */
  durationMs: number;
} & { [Counter in AgentModelCounter]?: number };

/** Add one allowlisted counter: absent values stay absent, and unsafe sums are skipped. */
export function addModelCounter(
  target: StoredAgentModelUsage,
  name: AgentModelCounter,
  value: number | undefined
): void {
  if (value === undefined) return;
  const total = (target[name] ?? 0) + value;
  if (Number.isSafeInteger(total)) target[name] = total;
}

/** Bounds retention for malformed traces that report unbounded model names. */
const MAX_MODEL_USAGE_ENTRIES = 8;

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/** Retain only recognized agent telemetry, never arbitrary attempt attributes. */
export class AgentProjection {
  #definition: StoredAgentDefinition | undefined;
  #turn: Omit<StoredAgentTurnMetadata, "calls"> | undefined;
  #call: StoredAgentCallMetadata | undefined;
  readonly #calls = new Map<string, StoredAgentCallMetadata>();
  readonly #usage = new Map<string, StoredAgentModelUsage>();

  snapshot(): Pick<StoredPipelineRun, "agent" | "agentTurn" | "agentCall"> {
    const snapshot: Pick<StoredPipelineRun, "agent" | "agentTurn" | "agentCall"> = {};
    if (this.#definition) snapshot.agent = structuredClone(this.#definition);
    if (this.#turn) {
      snapshot.agentTurn = {
        ...this.#turn,
        calls: [...this.#calls.values()].map((call) => ({ ...call })),
      };
      if (this.#usage.size)
        snapshot.agentTurn.usage = [...this.#usage.values()].map((entry) => ({ ...entry }));
    }
    if (this.#call) snapshot.agentCall = { ...this.#call };
    return snapshot;
  }

  append(event: StoredPipelineEvent): void {
    if (event.name === "pipeline.started" && !this.#definition) {
      const step = event.payload.definitionSnapshot?.steps.find((step) => step.agent);
      if (step?.agent)
        this.#definition = {
          stepId: step.id,
          limits: { ...step.agent.limits },
          capabilities: step.agent.capabilities.map(({ name }) => name),
        };
    }
    if (event.name !== "step.attempted") return;
    const attributes = event.payload.attributes;
    const provider = text(attributes["agent.model.provider"]);
    const model = text(attributes["agent.model.name"]);
    const request = count(attributes["agent.model.request"]);
    const iteration = event.iteration;
    // Model requests carry `agent.turn` but no `agent.runId`; the turn run owns their usage.
    if (
      provider &&
      model &&
      iteration &&
      event.stepId === "decide" &&
      event.parentRunId === iteration.runId &&
      count(attributes["agent.turn"]) === iteration.index &&
      request !== undefined &&
      request >= 1
    ) {
      this.#recordModelUsage(iteration, provider, model, attributes);
      return;
    }
    const agentRunId = text(attributes["agent.runId"]);
    const index = count(attributes["agent.turn"]);
    if (!agentRunId || !index) return;
    const callId = text(attributes["agent.callId"]);
    const tool = text(attributes["agent.tool"]);
    const parentAttemptId = text(attributes["agent.parentAttemptId"]);
    const call =
      callId && tool && parentAttemptId
        ? { agentRunId, turn: index, callId, tool, parentAttemptId }
        : undefined;
    if (!event.iteration) {
      // Older handler tools already emitted their own attribution.
      if (event.stepId === "tool" && call && event.itemKey === call.callId) this.#call = call;
      return;
    }
    if (
      event.iteration.runId !== agentRunId ||
      event.parentRunId !== agentRunId ||
      event.iteration.index !== index ||
      !["decide", "calls", "reduce"].includes(event.stepId)
    )
      return;
    this.#turn ??= { agentRunId, index };
    if (call) {
      if (event.stepId === "calls" && event.attemptId === parentAttemptId) {
        this.#calls.set(JSON.stringify([parentAttemptId, callId]), call);
      }
      return;
    }
    if (event.stepId === "decide") {
      const decision = attributes["agent.decision"];
      if (decision === "continue" || decision === "finish") this.#turn.decision = decision;
      const version = count(attributes["agent.stateVersion"]);
      if (version !== undefined) this.#turn.stateVersion = version;
    }
    if (event.stepId === "reduce") {
      const version = count(attributes["agent.stateVersion"]);
      if (version !== undefined) this.#turn.nextStateVersion = version;
    }
    const callCount = count(attributes["agent.callCount"]);
    const admitted = count(attributes["agent.callsAdmitted"]);
    if (callCount !== undefined) this.#turn.callCount = callCount;
    if (admitted !== undefined) this.#turn.callsAdmitted = admitted;
  }

  /** Sum one recognized model request; absent counters stay absent, never zero. */
  #recordModelUsage(
    iteration: NonNullable<StoredPipelineEvent["iteration"]>,
    provider: string,
    model: string,
    attributes: PipelineTraceAttributes
  ): void {
    this.#turn ??= { agentRunId: iteration.runId, index: iteration.index };
    const key = JSON.stringify([provider, model]);
    let entry = this.#usage.get(key);
    if (!entry) {
      if (this.#usage.size >= MAX_MODEL_USAGE_ENTRIES) return;
      entry = { provider, model, requests: 0, requestsWithoutUsage: 0, durationMs: 0 };
      this.#usage.set(key, entry);
    }
    entry.requests += 1;
    const duration = attributes["agent.model.durationMs"];
    if (typeof duration === "number" && Number.isFinite(duration) && duration >= 0)
      entry.durationMs += duration;
    for (const name of AGENT_MODEL_COUNTERS)
      addModelCounter(entry, name, count(attributes[`agent.model.${name}`]));
    if (
      count(attributes["agent.model.inputTokens"]) === undefined ||
      count(attributes["agent.model.outputTokens"]) === undefined
    )
      entry.requestsWithoutUsage += 1;
  }
}
