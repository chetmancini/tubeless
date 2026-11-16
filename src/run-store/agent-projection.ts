import type { PipelineDefinitionSnapshot } from "../core/pipeline-types.js";
import type { PipelineTraceAttributes } from "../tracing/tracing-contracts.js";
import {
  AGENT_MODEL_ATTRIBUTES,
  AGENT_MODEL_COUNTERS,
  AGENT_TRACE_ATTRIBUTES,
  AGENT_TURN_STEPS,
  type AgentModelCounter,
} from "../tracing/agent-telemetry.js";
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
const agentTurnSteps = new Set<string>(Object.values(AGENT_TURN_STEPS));

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

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
    const provider = text(attributes[AGENT_MODEL_ATTRIBUTES.provider]);
    const model = text(attributes[AGENT_MODEL_ATTRIBUTES.name]);
    const request = count(attributes[AGENT_MODEL_ATTRIBUTES.request]);
    const iteration = event.iteration;
    // Model requests carry `agent.turn` but no `agent.runId`; the turn run owns their usage.
    // A resumed invocation restarts `iteration.index` at 1 while the reporter keeps counting
    // logical turns, so the two are not comparable: the request's own turn is authoritative.
    const turn = count(attributes[AGENT_TRACE_ATTRIBUTES.turn]);
    if (
      provider &&
      model &&
      iteration &&
      event.stepId === AGENT_TURN_STEPS.decide &&
      event.parentRunId === iteration.runId &&
      turn !== undefined &&
      turn >= 1 &&
      request !== undefined &&
      request >= 1
    ) {
      this.#recordModelUsage(iteration.runId, turn, provider, model, attributes);
      return;
    }
    const agentRunId = text(attributes[AGENT_TRACE_ATTRIBUTES.runId]);
    const index = count(attributes[AGENT_TRACE_ATTRIBUTES.turn]);
    if (!agentRunId || !index) return;
    const callId = text(attributes[AGENT_TRACE_ATTRIBUTES.callId]);
    const tool = text(attributes[AGENT_TRACE_ATTRIBUTES.tool]);
    const parentAttemptId = text(attributes[AGENT_TRACE_ATTRIBUTES.parentAttemptId]);
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
      !agentTurnSteps.has(event.stepId)
    )
      return;
    this.#turn ??= { agentRunId, index };
    if (call) {
      if (event.stepId === AGENT_TURN_STEPS.calls && event.attemptId === parentAttemptId) {
        this.#calls.set(JSON.stringify([parentAttemptId, callId]), call);
      }
      return;
    }
    if (event.stepId === AGENT_TURN_STEPS.decide) {
      const decision = attributes[AGENT_TRACE_ATTRIBUTES.decision];
      if (decision === "continue" || decision === "finish") this.#turn.decision = decision;
      const version = count(attributes[AGENT_TRACE_ATTRIBUTES.stateVersion]);
      if (version !== undefined) this.#turn.stateVersion = version;
    }
    if (event.stepId === AGENT_TURN_STEPS.reduce) {
      const version = count(attributes[AGENT_TRACE_ATTRIBUTES.stateVersion]);
      if (version !== undefined) this.#turn.nextStateVersion = version;
    }
    const callCount = count(attributes[AGENT_TRACE_ATTRIBUTES.callCount]);
    const admitted = count(attributes[AGENT_TRACE_ATTRIBUTES.callsAdmitted]);
    if (callCount !== undefined) this.#turn.callCount = callCount;
    if (admitted !== undefined) this.#turn.callsAdmitted = admitted;
  }

  #recordModelUsage(
    agentRunId: string,
    turn: number,
    provider: string,
    model: string,
    attributes: PipelineTraceAttributes
  ): void {
    this.#turn ??= { agentRunId, index: turn };
    const key = JSON.stringify([provider, model]);
    let entry = this.#usage.get(key);
    if (!entry) {
      if (this.#usage.size >= MAX_MODEL_USAGE_ENTRIES) return;
      entry = { provider, model, requests: 0, requestsWithoutUsage: 0, durationMs: 0 };
      this.#usage.set(key, entry);
    }
    entry.requests += 1;
    const duration = attributes[AGENT_MODEL_ATTRIBUTES.durationMs];
    // A sum that overflows to Infinity would fail the stored run wire schema.
    if (
      typeof duration === "number" &&
      Number.isFinite(duration) &&
      duration >= 0 &&
      Number.isFinite(entry.durationMs + duration)
    )
      entry.durationMs += duration;
    for (const name of AGENT_MODEL_COUNTERS)
      addModelCounter(entry, name, count(attributes[AGENT_MODEL_ATTRIBUTES[name]]));
    if (
      count(attributes[AGENT_MODEL_ATTRIBUTES.inputTokens]) === undefined ||
      count(attributes[AGENT_MODEL_ATTRIBUTES.outputTokens]) === undefined
    )
      entry.requestsWithoutUsage += 1;
  }
}
