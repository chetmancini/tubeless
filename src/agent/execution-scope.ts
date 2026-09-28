import { executionScope, type ExecutionScope } from "../core/execution-scope.js";
import { createAbortError, throwIfAborted } from "../utilities/abort.js";
import { agentError } from "./agent-state.js";
import type { AgentLimits } from "./agent-types.js";

export function limit(
  name: string,
  bound: number,
  consumed: number,
  requested: number,
  scope: string
): never {
  throw agentError(
    "TUBELESS_AGENT_LIMIT_REACHED",
    `Agent ${name}=${bound} exceeded (consumed=${consumed}, requested=${requested}, scope=${scope})`
  );
}

export function resolvedLimits(limits: AgentLimits = {}): Required<AgentLimits> {
  const defaults = {
    maxTurns: 20,
    maxCalls: 100,
    maxDecisions: 100,
    maxDepth: 4,
    maxConcurrency: 1,
  };
  for (const key of Object.keys(limits)) {
    if (!Object.hasOwn(defaults, key))
      throw agentError("TUBELESS_AGENT_INVALID_DEFINITION", `Unsupported agent limit: ${key}`);
  }
  const result = { ...defaults };
  for (const key of Object.keys(defaults) as (keyof AgentLimits)[]) {
    const value = limits[key] === undefined ? defaults[key] : limits[key];
    const minimum = key === "maxCalls" || key === "maxDepth" ? 0 : 1;
    if (!Number.isSafeInteger(value) || value < minimum)
      throw agentError(
        "TUBELESS_AGENT_INVALID_DEFINITION",
        `Agent ${key} must be a ${minimum === 0 ? "nonnegative" : "positive"} safe integer`
      );
    result[key] = value;
  }
  return Object.freeze(result);
}

interface Budget {
  id: string;
  depth: number;
  limits: Required<AgentLimits>;
  maxCalls: number;
  maxDecisions: number;
  active: number;
}

interface Waiting {
  budgets: readonly Budget[];
  signal?: AbortSignal;
  cancel(error: Error): void;
  start(): void;
}

/** One queue per root, admitting all ancestor/local permits together. */
class LeafQueue {
  private readonly waiting = new Set<Waiting>();
  private readonly aborts = new Map<AbortSignal, { jobs: Set<Waiting>; cancel(): void }>();

  private watch(job: Waiting): void {
    const { signal } = job;
    if (!signal) return;
    let group = this.aborts.get(signal);
    if (!group) {
      const jobs = new Set<Waiting>();
      const cancel = () => {
        this.aborts.delete(signal);
        for (const pending of jobs) {
          this.waiting.delete(pending);
          pending.cancel(createAbortError(signal, "Agent execution"));
        }
      };
      group = { jobs, cancel };
      this.aborts.set(signal, group);
      signal.addEventListener("abort", cancel, { once: true });
    }
    group.jobs.add(job);
  }

  private unwatch(job: Waiting): void {
    const { signal } = job;
    const group = signal && this.aborts.get(signal);
    if (!group) return;
    group.jobs.delete(job);
    if (group.jobs.size === 0) {
      signal.removeEventListener("abort", group.cancel);
      this.aborts.delete(signal);
    }
  }

  private drain(): void {
    for (const job of this.waiting) {
      if (job.budgets.some((budget) => budget.active >= budget.limits.maxConcurrency)) continue;
      this.waiting.delete(job);
      for (const budget of job.budgets) budget.active++;
      job.start();
    }
  }

  async run<T>(
    budgets: readonly Budget[],
    work: () => Promise<T>,
    signal?: AbortSignal
  ): Promise<T> {
    throwIfAborted(signal, "Agent execution");
    await new Promise<void>((resolve, reject) => {
      const job: Waiting = {
        budgets,
        signal,
        cancel: reject,
        start: () => {
          this.unwatch(job);
          resolve();
        },
      };
      this.watch(job);
      this.waiting.add(job);
      this.drain();
    });
    try {
      throwIfAborted(signal, "Agent execution");
      return await work();
    } finally {
      for (const budget of budgets) budget.active--;
      this.drain();
    }
  }
}

/** Mutable counters belong to invocation-local scopes; definitions never retain them. */
export class AgentExecutionScope implements ExecutionScope {
  private constructor(
    private readonly budgets: readonly Budget[],
    private readonly queue: LeafQueue,
    private readonly depth: number
  ) {}

  static enter(context: object, limits: Required<AgentLimits>, id: string): AgentExecutionScope {
    const parent = agentScope(context);
    const depth = parent?.depth ?? 0;
    const budget: Budget = { id, depth, limits, maxCalls: 0, maxDecisions: 0, active: 0 };
    return new AgentExecutionScope(
      [...(parent?.budgets ?? []), budget],
      parent?.queue ?? new LeafQueue(),
      depth
    );
  }

  check(kind: "maxCalls" | "maxDecisions", count: number): void {
    for (const budget of this.budgets)
      if (count > budget.limits[kind] - budget[kind])
        limit(kind, budget.limits[kind], budget[kind], count, budget.id);
  }

  reserve(kind: "maxCalls" | "maxDecisions", count: number, signal?: AbortSignal): void {
    throwIfAborted(signal, "Agent admission");
    this.check(kind, count);
    // No await between checking every ancestor and charging the complete batch. No refunds.
    for (const budget of this.budgets) budget[kind] += count;
  }

  delegate(): AgentExecutionScope {
    for (const budget of this.budgets) {
      const consumed = this.depth - budget.depth;
      if (consumed >= budget.limits.maxDepth)
        limit("maxDepth", budget.limits.maxDepth, consumed, 1, budget.id);
    }
    return new AgentExecutionScope(this.budgets, this.queue, this.depth + 1);
  }

  run<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return this.queue.run(this.budgets, work, signal);
  }
}

export function agentScope(context: object): AgentExecutionScope | undefined {
  const scope = executionScope(context);
  return scope instanceof AgentExecutionScope ? scope : undefined;
}
