import { agentError, limit } from "./agent-state.js";
import { plainAgentCheckpointCodec } from "./checkpoint-codec.js";
import type {
  AgentCheckpointCodec,
  AgentCheckpointLease,
  AgentCheckpointStore,
} from "./checkpoint-types.js";
import { checkCheckpointKey } from "./checkpoint-key.js";
import { checkedCheckpoint } from "./checkpoint-format.js";
import type {
  CallOutcome,
  Checkpoint,
  SavedAgent,
  SavedCall,
  SavedDecision,
  StoredBudget,
} from "./checkpoint-format.js";

export interface BudgetReference {
  key: string;
  id: string;
}

type CallingAgent = Extract<SavedAgent, { phase: "calls" }>;

function callingAgent(checkpoint: Checkpoint, key: string): CallingAgent {
  const saved = checkpoint.agents[key];
  if (!saved || saved.phase !== "calls") throw new Error("Agent has no accepted call batch");
  return saved;
}

/** One owner for acknowledged state transitions and budgets across a durable subtree. */
export class AgentCheckpointSession {
  #checkpoint: Checkpoint;
  #tail = Promise.resolve();
  #failure: { error: unknown } | undefined;
  private constructor(
    readonly key: string,
    private readonly lease: AgentCheckpointLease,
    private readonly codec: AgentCheckpointCodec,
    checkpoint: Checkpoint
  ) {
    this.#checkpoint = checkpoint;
  }
  static async open(
    store: AgentCheckpointStore,
    key: string,
    codec: AgentCheckpointCodec = plainAgentCheckpointCodec
  ): Promise<AgentCheckpointSession> {
    checkCheckpointKey(key);
    const lease = await store.acquire(key);
    try {
      const bytes = await lease.read();
      const checkpoint =
        bytes === undefined
          ? { version: 1 as const, agents: {}, budgets: {} }
          : checkedCheckpoint(codec.decode(bytes));
      return new AgentCheckpointSession(key, lease, codec, checkpoint);
    } catch (error) {
      await lease.close();
      throw error;
    }
  }
  private roundTrip<T>(value: T): { encoded: string; decoded: T } {
    const encoded = this.codec.encode(value);
    const decoded = this.codec.decode(encoded);
    if (this.codec.encode(decoded) !== encoded)
      throw agentError(
        "TUBELESS_AGENT_CHECKPOINT_CODEC",
        "Agent checkpoint codec must round-trip deterministically"
      );
    // SAFETY: codecs promise lossless round trips; the default checks finite plain data.
    return { encoded, decoded: decoded as T };
  }
  agent(key: string): SavedAgent | undefined {
    const value = this.#checkpoint.agents[key];
    return value === undefined ? undefined : this.roundTrip(value).decoded;
  }
  decision(key: string): SavedDecision | undefined {
    const saved = this.agent(key);
    return saved?.phase === "calls" ? saved.decision : undefined;
  }
  budget(key: string): Readonly<StoredBudget> {
    const saved = this.#checkpoint.budgets[key];
    if (!saved) throw new Error("Saved agent budget disappeared");
    return { ...saved, limits: { ...saved.limits } };
  }
  async enter(
    key: string,
    metadata: SavedAgent["metadata"],
    budget: Pick<StoredBudget, "depth" | "limits">,
    initialize: () => SavedAgent["execution"]
  ): Promise<SavedAgent> {
    const saved = this.agent(key);
    if (saved) {
      const restored = this.budget(key);
      if (this.codec.encode(saved.metadata) !== this.codec.encode(metadata))
        throw agentError(
          "TUBELESS_AGENT_CHECKPOINT_MISMATCH",
          "Agent checkpoint definition, inputs or workspace differ; use a new execution key"
        );
      if (
        this.codec.encode({ depth: restored.depth, limits: restored.limits }) !==
        this.codec.encode(budget)
      )
        throw agentError(
          "TUBELESS_AGENT_CHECKPOINT_MISMATCH",
          "Saved agent limits or delegation depth differ"
        );
      return saved;
    }
    await this.update((checkpoint) => {
      checkpoint.budgets[key] = { ...budget, maxCalls: 0, maxDecisions: 0 };
      checkpoint.agents[key] = { metadata, execution: initialize(), phase: "decide" };
    });
    const entered = this.agent(key);
    if (!entered) throw new Error("Saved agent disappeared");
    return entered;
  }
  private charge(
    checkpoint: Checkpoint,
    budgets: readonly BudgetReference[],
    kind: "maxCalls" | "maxDecisions",
    count: number
  ): void {
    for (const { key, id } of budgets) {
      const budget = checkpoint.budgets[key];
      if (!budget) throw new Error("Saved agent budget disappeared");
      if (count > budget.limits[kind] - budget[kind])
        limit(kind, budget.limits[kind], budget[kind], count, id);
    }
    for (const { key } of budgets) checkpoint.budgets[key]![kind] += count;
  }
  reserve(
    budgets: readonly BudgetReference[],
    kind: "maxCalls" | "maxDecisions",
    count: number
  ): Promise<void> {
    return this.update((checkpoint) => this.charge(checkpoint, budgets, kind, count));
  }
  acceptDecision(key: string, state: unknown, calls: SavedCall[]): Promise<void> {
    return this.update((checkpoint) => {
      const saved = checkpoint.agents[key];
      if (!saved || saved.phase !== "decide") throw new Error("Agent is not awaiting a decision");
      checkpoint.agents[key] = {
        metadata: saved.metadata,
        execution: saved.execution,
        phase: "calls",
        decision: { state, calls, admitted: false },
      };
    });
  }
  admitCalls(key: string, budgets: readonly BudgetReference[], count: number): Promise<void> {
    return this.update((checkpoint) => {
      const saved = callingAgent(checkpoint, key);
      if (saved.decision.admitted) return;
      this.charge(checkpoint, budgets, "maxCalls", count);
      saved.decision.admitted = true;
    });
  }
  async startCall(
    key: string,
    id: string,
    replay: "safe" | "unsafe"
  ): Promise<{ kind: "run" } | { kind: "outcome"; outcome: CallOutcome; reused: boolean }> {
    const saved = this.decision(key)?.calls.find((call) => call.id === id);
    if (!saved) throw new Error("Saved agent call disappeared");
    if (saved.status === "completed")
      return { kind: "outcome", outcome: saved.outcome, reused: true };
    if (saved.status === "running" && (saved.replay !== "safe" || replay !== "safe")) {
      const outcome: CallOutcome = {
        id,
        tool: saved.tool,
        ok: false,
        error: {
          code: "TUBELESS_AGENT_CALL_INTERRUPTED",
          message: `Tool ${saved.tool} was interrupted and may have partially run; inspect its effects before retrying`,
        },
      };
      await this.completeCall(key, id, outcome);
      return { kind: "outcome", outcome, reused: false };
    }
    await this.changeCall(key, id, (call) => {
      if (call.status === "completed") throw new Error("Saved agent call already completed");
      return { ...call, status: "running" };
    });
    return { kind: "run" };
  }
  completeCall(key: string, id: string, outcome: CallOutcome): Promise<void> {
    return this.changeCall(key, id, (call) => ({ ...call, status: "completed", outcome }));
  }
  private changeCall(
    key: string,
    id: string,
    change: (call: SavedCall) => SavedCall
  ): Promise<void> {
    return this.update((checkpoint) => {
      const saved = callingAgent(checkpoint, key);
      if (!saved.decision.admitted) throw new Error("Saved call batch has not been admitted");
      const index = saved.decision.calls.findIndex((call) => call.id === id);
      const call = saved.decision.calls[index];
      if (!call) throw new Error("Saved agent call disappeared");
      saved.decision.calls[index] = change(call);
    });
  }
  advance(key: string, execution: SavedAgent["execution"]): Promise<void> {
    return this.update((checkpoint) => {
      const saved = callingAgent(checkpoint, key);
      if (saved.decision.calls.some((call) => call.status !== "completed"))
        throw new Error("Agent call batch has unfinished work");
      checkpoint.agents[key] = { metadata: saved.metadata, execution, phase: "decide" };
    });
  }
  finish(key: string, result: unknown): Promise<void> {
    return this.update((checkpoint) => {
      const saved = checkpoint.agents[key];
      if (!saved || saved.phase !== "decide")
        throw new Error("Agent is not awaiting a finish decision");
      checkpoint.agents[key] = {
        metadata: saved.metadata,
        execution: saved.execution,
        phase: "completed",
        result,
      };
    });
  }
  fail(key: string, error: unknown, signal?: AbortSignal): Promise<void> {
    if (this.#failure || signal?.aborted) return Promise.resolve();
    return this.update((checkpoint) => {
      const saved = checkpoint.agents[key];
      if (!saved) throw new Error("Saved agent disappeared");
      checkpoint.agents[key] = {
        metadata: saved.metadata,
        execution: saved.execution,
        phase: "failed",
        failure: {
          code:
            error instanceof Error && "code" in error && typeof error.code === "string"
              ? error.code
              : "TUBELESS_AGENT_EXECUTION_FAILED",
          message: error instanceof Error ? error.message : String(error),
        },
      };
    });
  }
  private update(change: (checkpoint: Checkpoint) => void): Promise<void> {
    const write = this.#tail.then(async () => {
      if (this.#failure) throw this.#failure.error;
      const checkpoint = this.roundTrip(this.#checkpoint).decoded;
      change(checkpoint);
      try {
        const { encoded, decoded } = this.roundTrip(checkedCheckpoint(checkpoint));
        const checked = checkedCheckpoint(decoded);
        await this.lease.write(encoded);
        this.#checkpoint = checked;
      } catch (error) {
        this.#failure ??= { error };
        throw error;
      }
    });
    // A rejected transition changed only the private copy. Failed persistence requires reopening storage.
    this.#tail = write.catch(() => {});
    return write;
  }
  async close(): Promise<void> {
    await this.#tail;
    await this.lease.close();
  }
}
