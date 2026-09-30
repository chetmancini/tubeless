import type { PipelineDefinitionSnapshot } from "../core/pipeline-types.js";
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
}

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

  snapshot(): Pick<StoredPipelineRun, "agent" | "agentTurn" | "agentCall"> {
    const snapshot: Pick<StoredPipelineRun, "agent" | "agentTurn" | "agentCall"> = {};
    if (this.#definition) snapshot.agent = structuredClone(this.#definition);
    if (this.#turn)
      snapshot.agentTurn = {
        ...this.#turn,
        calls: [...this.#calls.values()].map((call) => ({ ...call })),
      };
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
}
