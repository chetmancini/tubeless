import { randomUUID } from "node:crypto";
import { availableParallelism, cpus, release, totalmem } from "node:os";
import {
  digest,
  duration,
  id,
  imageDigest,
  isHostedMeasurements,
  matches,
  oneOf,
  positiveInteger,
  sha,
  shape,
  version,
  type HostedMeasurements,
} from "./measurements.ts";
import { variants, workload, type Workload } from "./workload.ts";

const modes = ["local", "cloud", "cloud-fixture"] as const;
const operations = ["start", "resume", "replay"] as const;
const stages = ["prepare", "execute", "submit", "follow", "inspect"] as const;
const states = ["pending", "observed", "error", "timeout", "cancelled"] as const;
const outcomes = [
  "unknown",
  "passed",
  "assertion-failure",
  "failed",
  "timed-out",
  "cancelled",
  "interrupted",
] as const;
const identities = ["unknown", "verified", "mismatch"] as const;
const conditions = ["fresh-local-v1", "cloud-portable-v1"] as const;

export type Target = {
  host: string;
  workspace: string;
  pipelineId: string;
  idempotencyKey: string;
  principalId: string | null;
};
type Client = {
  platform: string;
  arch: string;
  osRelease: string;
  cpuModel: string;
  logicalCpus: number;
  memoryBytes: number;
};

export type Sample = {
  version: 1;
  attemptId: string;
  invocationId: string;
  startedAt: string;
  workload: Workload;
  mode: (typeof modes)[number];
  operation: (typeof operations)[number];
  condition: (typeof conditions)[number];
  client: Client;
  target: Target | null;
  tools: { driverBun: string; driverTubeless: string; node: string | null; bun: string | null };
  execution: {
    runId: string | null;
    identity: (typeof identities)[number];
    imageDigest: string | null;
    outcome: (typeof outcomes)[number];
  };
  observation: {
    stage: (typeof stages)[number];
    state: (typeof states)[number];
    deadlineMs: number;
    admissionMs: number | null;
    terminalMs: number | null;
    localPreparationMs: number | null;
    localRecipeMs: number | null;
  };
  hostedMeasurements: HostedMeasurements | null;
};

export type Checkpoint = () => Promise<void>;

function clientContext(): Client {
  return {
    platform: process.platform,
    arch: process.arch,
    osRelease: release(),
    cpuModel: cpus()[0]?.model || "unknown",
    logicalCpus: availableParallelism(),
    memoryBytes: totalmem(),
  };
}

export function newSample(
  intent: Pick<Sample, "attemptId" | "workload" | "mode" | "operation" | "target">,
  tools: Pick<Sample["tools"], "driverBun" | "driverTubeless">,
  deadlineMs: number,
  runId: string | null
): Sample {
  return {
    version: 1,
    ...intent,
    invocationId: randomUUID(),
    startedAt: new Date().toISOString(),
    condition: intent.mode === "local" ? "fresh-local-v1" : "cloud-portable-v1",
    client: clientContext(),
    tools: { ...tools, node: null, bun: null },
    execution: { runId, identity: "unknown", imageDigest: null, outcome: "unknown" },
    observation: {
      stage: "prepare",
      state: "pending",
      deadlineMs,
      admissionMs: null,
      terminalMs: null,
      localPreparationMs: null,
      localRecipeMs: null,
    },
    hostedMeasurements: null,
  };
}

export function cloudOrigin(value: string): string {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
  )
    throw new Error("Use a Cloud origin with no credentials, path, query or fragment.");
  return url.origin;
}

function isTarget(value: unknown): value is Target {
  if (
    !shape(value, ["host", "workspace", "pipelineId", "idempotencyKey", "principalId"]) ||
    typeof value.host !== "string" ||
    (value.principalId !== null && !matches(value.principalId, id)) ||
    ![value.workspace, value.pipelineId, value.idempotencyKey].every((entry) => matches(entry, id))
  )
    return false;
  return cloudOrigin(value.host) === value.host;
}

function isWorkload(value: unknown, mode: Sample["mode"]): boolean {
  if (
    !shape(value, [
      "id",
      "variant",
      "repository",
      "commit",
      "treeSha",
      "lockfileDigest",
      "planDigest",
    ]) ||
    value.id !== "portable-node-check-v1" ||
    !oneOf(value.variant, variants) ||
    !matches(value.repository, /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i) ||
    !matches(value.commit, sha) ||
    !matches(value.treeSha, sha) ||
    !matches(value.lockfileDigest, digest) ||
    !matches(value.planDigest, digest)
  )
    return false;
  return (
    mode === "cloud-fixture" ||
    Object.entries(workload(value.variant)).every(([key, entry]) => value[key] === entry)
  );
}

function isClient(value: unknown): boolean {
  return (
    shape(value, ["platform", "arch", "osRelease", "cpuModel", "logicalCpus", "memoryBytes"]) &&
    [value.platform, value.arch, value.osRelease, value.cpuModel].every((entry) =>
      matches(entry, /^[\x20-\x7e]{1,200}$/)
    ) &&
    positiveInteger(value.logicalCpus) &&
    positiveInteger(value.memoryBytes)
  );
}

function isTools(value: unknown): boolean {
  return (
    shape(value, ["driverBun", "driverTubeless", "node", "bun"]) &&
    matches(value.driverBun, version) &&
    matches(value.driverTubeless, version) &&
    [value.node, value.bun].every((entry) => entry === null || matches(entry, version))
  );
}

function isExecution(value: unknown): value is Sample["execution"] {
  return (
    shape(value, ["runId", "identity", "imageDigest", "outcome"]) &&
    (value.runId === null || matches(value.runId, id)) &&
    oneOf(value.identity, identities) &&
    oneOf(value.outcome, outcomes) &&
    (value.imageDigest === null || matches(value.imageDigest, imageDigest)) &&
    (value.runId !== null || value.outcome === "unknown")
  );
}

function isObservation(value: unknown): value is Sample["observation"] {
  return (
    shape(value, [
      "stage",
      "state",
      "deadlineMs",
      "admissionMs",
      "terminalMs",
      "localPreparationMs",
      "localRecipeMs",
    ]) &&
    oneOf(value.stage, stages) &&
    oneOf(value.state, states) &&
    positiveInteger(value.deadlineMs) &&
    [value.admissionMs, value.terminalMs, value.localPreparationMs, value.localRecipeMs].every(
      (entry) => entry === null || duration(entry)
    )
  );
}

export function readSample(value: unknown): Sample {
  if (
    !shape(value, [
      "version",
      "attemptId",
      "invocationId",
      "startedAt",
      "workload",
      "mode",
      "operation",
      "condition",
      "client",
      "target",
      "tools",
      "execution",
      "observation",
      "hostedMeasurements",
    ]) ||
    value.version !== 1 ||
    !matches(value.attemptId, id) ||
    !matches(value.invocationId, id) ||
    !matches(value.startedAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/) ||
    new Date(value.startedAt).toISOString() !== value.startedAt ||
    !oneOf(value.mode, modes) ||
    !oneOf(value.operation, operations) ||
    !oneOf(value.condition, conditions) ||
    !isWorkload(value.workload, value.mode) ||
    !isClient(value.client) ||
    !isTools(value.tools) ||
    !isExecution(value.execution) ||
    !isObservation(value.observation) ||
    (value.observation.state === "observed" &&
      (value.execution.identity !== "verified" ||
        value.execution.outcome === "unknown" ||
        (value.operation === "start" && value.observation.terminalMs === null))) ||
    (value.operation !== "start" && value.observation.terminalMs !== null)
  )
    throw new Error("Invalid benchmark sample v1.");
  if (value.mode === "local") {
    if (
      value.operation !== "start" ||
      value.condition !== "fresh-local-v1" ||
      value.target !== null ||
      value.hostedMeasurements !== null ||
      value.execution.imageDigest !== null ||
      value.observation.admissionMs !== null ||
      !["prepare", "execute"].includes(value.observation.stage)
    )
      throw new Error("Invalid local benchmark sample.");
  } else if (
    !isTarget(value.target) ||
    value.target.idempotencyKey !== "node-check-bench:" + value.attemptId ||
    (value.observation.stage !== "prepare" && value.target.principalId === null) ||
    value.condition !== "cloud-portable-v1" ||
    value.observation.localRecipeMs !== null ||
    value.observation.localPreparationMs !== null ||
    value.observation.stage === "execute" ||
    (value.hostedMeasurements !== null && !isHostedMeasurements(value.hostedMeasurements))
  ) {
    throw new Error("Invalid Cloud benchmark sample.");
  }
  return value as Sample;
}
