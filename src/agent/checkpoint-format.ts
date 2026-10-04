import type { AgentLimits, AgentOutcome, Tools } from "./agent-types.js";

export interface StoredBudget {
  depth: number;
  limits: Required<AgentLimits>;
  maxCalls: number;
  maxDecisions: number;
}
export type CallOutcome = AgentOutcome<Tools>;
export type SavedCall = {
  id: string;
  tool: string;
  replay: "safe" | "unsafe";
} & (
  | { kind: "handler"; input: unknown; validatedOptions?: never }
  | { kind: "pipeline"; input: object; validatedOptions: object }
) &
  (
    | { status: "pending" | "running"; outcome?: never }
    | { status: "completed"; outcome: CallOutcome }
  );
export interface SavedDecision {
  state: unknown;
  calls: SavedCall[];
  admitted: boolean;
}
interface AgentSnapshot {
  metadata: {
    definition: string;
    implementationVersion?: string;
    options: object;
    environment: string;
    cwd: string;
    cache: "use" | "recompute" | "bypass";
  };
  execution: { state: unknown; turn: number; stateVersion: number; calls: number };
}
export type SavedAgent = AgentSnapshot &
  (
    | { phase: "decide"; decision?: never; result?: never; failure?: never }
    | { phase: "calls"; decision: SavedDecision; result?: never; failure?: never }
    | { phase: "completed"; result: unknown; decision?: never; failure?: never }
    | {
        phase: "failed";
        failure: { code: string; message: string };
        decision?: never;
        result?: never;
      }
  );
export interface Checkpoint {
  version: 1;
  agents: Record<string, SavedAgent>;
  budgets: Record<string, StoredBudget>;
}

function record(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}
function natural(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function options(value: unknown): value is object {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function failure(value: unknown): boolean {
  return record(value) && typeof value.code === "string" && typeof value.message === "string";
}

function checkCall(call: unknown, admitted: boolean, ids: Set<string>): void {
  if (
    !record(call) ||
    typeof call.id !== "string" ||
    !call.id.trim() ||
    call.id.length > 256 ||
    ids.has(call.id) ||
    typeof call.tool !== "string" ||
    !/^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(call.tool) ||
    !["handler", "pipeline"].includes(String(call.kind)) ||
    !["safe", "unsafe"].includes(String(call.replay)) ||
    !["pending", "running", "completed"].includes(String(call.status)) ||
    !Object.hasOwn(call, "input")
  )
    throw new Error("Invalid saved call");
  ids.add(call.id);
  if (call.kind === "pipeline" && (!options(call.input) || !options(call.validatedOptions)))
    throw new Error("Invalid saved pipeline options");
  if (!admitted && call.status !== "pending") throw new Error("Unadmitted call has started");
  if (call.status === "completed") {
    const outcome = call.outcome;
    if (
      !record(outcome) ||
      outcome.id !== call.id ||
      outcome.tool !== call.tool ||
      typeof outcome.ok !== "boolean" ||
      (outcome.ok ? !Object.hasOwn(outcome, "value") : !failure(outcome.error))
    )
      throw new Error("Invalid saved call outcome");
  }
}

function checkAgent(agent: unknown): void {
  if (!record(agent) || !record(agent.metadata) || !record(agent.execution))
    throw new Error("Invalid saved agent");
  const { metadata, execution } = agent;
  if (
    typeof metadata.definition !== "string" ||
    typeof metadata.environment !== "string" ||
    typeof metadata.cwd !== "string" ||
    !options(metadata.options) ||
    (metadata.implementationVersion !== undefined &&
      typeof metadata.implementationVersion !== "string") ||
    !["use", "recompute", "bypass"].includes(String(metadata.cache))
  )
    throw new Error("Invalid saved agent metadata");
  if (
    !Object.hasOwn(execution, "state") ||
    !natural(execution.turn) ||
    execution.turn < 1 ||
    !natural(execution.stateVersion) ||
    !natural(execution.calls) ||
    !["decide", "calls", "completed", "failed"].includes(String(agent.phase))
  )
    throw new Error("Invalid saved agent execution");
  if (agent.phase === "completed" && !Object.hasOwn(agent, "result"))
    throw new Error("Missing saved agent result");
  if (agent.phase === "failed" && !failure(agent.failure))
    throw new Error("Invalid saved agent failure");
  if (agent.phase === "calls") {
    const decision = agent.decision;
    if (
      !record(decision) ||
      !Object.hasOwn(decision, "state") ||
      !Array.isArray(decision.calls) ||
      decision.calls.length === 0 ||
      typeof decision.admitted !== "boolean"
    )
      throw new Error("Invalid saved call batch");
    const ids = new Set<string>();
    for (const call of decision.calls) checkCall(call, decision.admitted, ids);
  }
}

function checkBudget(budget: unknown): void {
  if (
    !record(budget) ||
    !natural(budget.depth) ||
    !natural(budget.maxCalls) ||
    !natural(budget.maxDecisions) ||
    !record(budget.limits)
  )
    throw new Error("Invalid saved agent budget");
  for (const name of [
    "maxTurns",
    "maxCalls",
    "maxDecisions",
    "maxDepth",
    "maxConcurrency",
  ] as const) {
    const bound = budget.limits[name];
    if (!natural(bound) || (!["maxCalls", "maxDepth"].includes(name) && bound === 0))
      throw new Error("Invalid saved agent limits");
  }
  if (
    budget.maxCalls > Number(budget.limits.maxCalls) ||
    budget.maxDecisions > Number(budget.limits.maxDecisions)
  )
    throw new Error("Saved agent budget exceeds its limits");
}

/** Validate receipts and counters before treating decoded storage as prepared work. */
export function checkedCheckpoint(value: unknown): Checkpoint {
  if (!record(value) || value.version !== 1 || !record(value.agents) || !record(value.budgets))
    throw new Error("Invalid agent checkpoint envelope");
  for (const [key, agent] of Object.entries(value.agents)) {
    checkAgent(agent);
    if (!Object.hasOwn(value.budgets, key)) throw new Error("Missing saved agent budget");
  }
  for (const budget of Object.values(value.budgets)) checkBudget(budget);
  // SAFETY: metadata, execution counters, call receipts and budget contracts were checked above.
  return value as unknown as Checkpoint;
}
