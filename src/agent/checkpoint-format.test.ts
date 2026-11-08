import { describe, expect, it } from "vitest";
import { DEFAULT_AGENT_LIMITS } from "./agent-limits.js";
import { checkedCheckpoint } from "./checkpoint-format.js";

type Obj = Record<string, unknown>;

const budget = (): Obj => ({
  depth: 0,
  limits: { ...DEFAULT_AGENT_LIMITS },
  maxCalls: 100,
  maxDecisions: 100,
});
const metadata = (): Obj => ({
  definition: "def",
  options: {},
  environment: "env",
  cwd: "/tmp",
  cache: "use",
});
const execution = (): Obj => ({ state: null, turn: 1, stateVersion: 0, calls: 0 });
const call = (): Obj => ({
  id: "c1",
  tool: "work",
  replay: "safe",
  kind: "handler",
  input: 1,
  status: "pending",
});
const agentIn = (phase: string, extra: Obj = {}): Obj => ({
  metadata: metadata(),
  execution: execution(),
  phase,
  ...extra,
});
const checkpoint = (agent: Obj = agentIn("decide")): Obj => ({
  version: 1,
  agents: { a: agent },
  budgets: { a: budget() },
});
const withCalls = (calls: Obj[], extra: Obj = {}): Obj =>
  checkpoint(agentIn("calls", { decision: { state: null, admitted: true, calls, ...extra } }));
const withBudget = (patch: Obj, limits: Obj = {}): Obj => {
  const value = checkpoint();
  value.budgets = { a: { ...budget(), ...patch, limits: { ...DEFAULT_AGENT_LIMITS, ...limits } } };
  return value;
};
const withAgent = (patch: Obj): Obj => checkpoint({ ...agentIn("decide"), ...patch });
const completedCall = (outcome: Obj): Obj => ({ ...call(), status: "completed", outcome });

describe("checkedCheckpoint accepts", () => {
  const accepted: [string, Obj][] = [
    ["decide phase", checkpoint()],
    ["calls phase", withCalls([call()])],
    [
      "completed call with ok outcome",
      withCalls([completedCall({ id: "c1", tool: "work", ok: true, value: 2 })]),
    ],
    [
      "completed call with failed outcome",
      withCalls([
        completedCall({ id: "c1", tool: "work", ok: false, error: { code: "X", message: "m" } }),
      ]),
    ],
    [
      "pipeline call",
      withCalls([{ ...call(), kind: "pipeline", input: {}, validatedOptions: {} }]),
    ],
    ["completed phase", checkpoint(agentIn("completed", { result: 1 }))],
    [
      "completed phase with completedState",
      checkpoint(agentIn("completed", { result: 1, completedState: { state: 1 } })),
    ],
    ["failed phase", checkpoint(agentIn("failed", { failure: { code: "X", message: "m" } }))],
  ];
  it.each(accepted)("%s", (_name, value) => {
    expect(checkedCheckpoint(value)).toBe(value);
  });

  it("a null-prototype envelope", () => {
    const value = Object.assign(Object.create(null) as Obj, checkpoint());
    expect(checkedCheckpoint(value)).toBe(value);
  });
});

describe("checkedCheckpoint rejects", () => {
  const noBudget = { ...checkpoint(), budgets: {} };
  const noState = checkpoint({
    ...agentIn("decide"),
    execution: { turn: 1, stateVersion: 0, calls: 0 },
  });
  const rejected: [string, unknown, string][] = [
    ["null envelope", null, "Invalid agent checkpoint envelope"],
    ["array envelope", [], "Invalid agent checkpoint envelope"],
    ["version 2", { ...checkpoint(), version: 2 }, "Invalid agent checkpoint envelope"],
    ["array agents", { ...checkpoint(), agents: [] }, "Invalid agent checkpoint envelope"],
    ["array budgets", { ...checkpoint(), budgets: [] }, "Invalid agent checkpoint envelope"],
    ["agent without budget", noBudget, "Missing saved agent budget"],
    ["array metadata", withAgent({ metadata: [] }), "Invalid saved agent"],
    ["non-record agent", { ...checkpoint(), agents: { a: 1 } }, "Invalid saved agent"],
    [
      "unknown cache mode",
      withAgent({ metadata: { ...metadata(), cache: "always" } }),
      "Invalid saved agent metadata",
    ],
    [
      "numeric implementationVersion",
      withAgent({ metadata: { ...metadata(), implementationVersion: 1 } }),
      "Invalid saved agent metadata",
    ],
    [
      "zero turn",
      withAgent({ execution: { ...execution(), turn: 0 } }),
      "Invalid saved agent execution",
    ],
    [
      "negative calls",
      withAgent({ execution: { ...execution(), calls: -1 } }),
      "Invalid saved agent execution",
    ],
    ["execution without state", noState, "Invalid saved agent execution"],
    ["unknown phase", withAgent({ phase: "paused" }), "Invalid saved agent execution"],
    ["completed without result", checkpoint(agentIn("completed")), "Missing saved agent result"],
    [
      "completedState without state",
      checkpoint(agentIn("completed", { result: 1, completedState: {} })),
      "Invalid saved completed state",
    ],
    [
      "failure with non-string code",
      checkpoint(agentIn("failed", { failure: { code: 1, message: "m" } })),
      "Invalid saved agent failure",
    ],
    ["empty calls", withCalls([]), "Invalid saved call batch"],
    ["non-boolean admitted", withCalls([call()], { admitted: "yes" }), "Invalid saved call batch"],
    ["calls phase without decision", checkpoint(agentIn("calls")), "Invalid saved call batch"],
    ["duplicate call ids", withCalls([call(), call()]), "Invalid saved call"],
    ["bad tool name", withCalls([{ ...call(), tool: "1bad" }]), "Invalid saved call"],
    [
      "call without input",
      withCalls([Object.fromEntries(Object.entries(call()).filter(([k]) => k !== "input"))]),
      "Invalid saved call",
    ],
    [
      "pipeline with null validatedOptions",
      withCalls([{ ...call(), kind: "pipeline", input: {}, validatedOptions: null }]),
      "Invalid saved pipeline options",
    ],
    [
      "unadmitted running call",
      withCalls([{ ...call(), status: "running" }], { admitted: false }),
      "Unadmitted call has started",
    ],
    [
      "outcome id mismatch",
      withCalls([completedCall({ id: "other", tool: "work", ok: true, value: 2 })]),
      "Invalid saved call outcome",
    ],
    [
      "ok outcome without value",
      withCalls([completedCall({ id: "c1", tool: "work", ok: true })]),
      "Invalid saved call outcome",
    ],
    ["fractional depth", withBudget({ depth: 1.5 }), "Invalid saved agent budget"],
    ["zero maxTurns", withBudget({}, { maxTurns: 0 }), "Invalid saved agent limits"],
    [
      "budget maxCalls over limit",
      withBudget({ maxCalls: 101 }, { maxCalls: 100 }),
      "Saved agent budget exceeds its limits",
    ],
    [
      "budget maxDecisions over limit",
      withBudget({ maxDecisions: 101 }, { maxDecisions: 100 }),
      "Saved agent budget exceeds its limits",
    ],
  ];
  it.each(rejected)("%s", (_name, value, message) => {
    expect(() => checkedCheckpoint(value)).toThrow(message);
  });
});
