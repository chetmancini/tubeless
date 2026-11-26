import { randomUUID } from "node:crypto";
import { availableParallelism, cpus, release, totalmem } from "node:os";
import { isDeepStrictEqual } from "node:util";
import {
  wireEnum,
  wireLiteral,
  wireObject,
  wireRefine,
  type InferWireSchema,
} from "../../dist/tracing/wire-schema.js";
import { normalizeCloudHost } from "../../dist/workbench/cloud/config.js";
import {
  digest,
  gitSha,
  hostedMeasurements,
  identifier,
  imageDigest,
  milliseconds,
  nullable,
  pattern,
  positiveInteger,
  version,
  type HostedMeasurements,
} from "./measurements.ts";
import { selectWorkload, variants, workloadIds, type Workload } from "./workload.ts";

const strict = { strict: true } as const;
const nil = wireLiteral(null);
const hostLabel = pattern(/^[\x20-\x7e]{1,200}$/);
const target = wireObject(
  {
    host: wireRefine(hostLabel, (value, path) => {
      if (normalizeCloudHost(value) !== value)
        throw new Error(path + " must be a canonical origin");
    }),
    workspace: identifier,
    pipelineId: identifier,
    idempotencyKey: identifier,
    principalId: nullable(identifier),
  },
  strict
);
const identity = wireEnum(["unknown", "verified", "mismatch"]);
const outcome = wireEnum([
  "unknown",
  "passed",
  "assertion-failure",
  "failed",
  "timed-out",
  "cancelled",
  "interrupted",
]);
const execution = { runId: nullable(identifier), identity, outcome };
const observation = {
  state: wireEnum(["pending", "observed", "error", "timeout", "cancelled"]),
  deadlineMs: positiveInteger,
  terminalMs: milliseconds,
};
const shared = {
  version: wireLiteral(1),
  attemptId: identifier,
  invocationId: identifier,
  startedAt: wireRefine(pattern(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/), (value, path) => {
    if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value)
      throw new Error(path + " must be a UTC timestamp");
  }),
  workload: wireObject(
    {
      id: wireEnum(workloadIds),
      variant: wireEnum(variants),
      repository: pattern(/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i),
      commit: gitSha,
      treeSha: gitSha,
      lockfileDigest: digest,
      planDigest: digest,
    },
    strict
  ),
  client: wireObject(
    {
      platform: hostLabel,
      arch: hostLabel,
      osRelease: hostLabel,
      cpuModel: hostLabel,
      logicalCpus: positiveInteger,
      memoryBytes: positiveInteger,
    },
    strict
  ),
  tools: wireObject(
    {
      driverBun: version,
      driverTubeless: version,
      node: nullable(version),
      bun: nullable(version),
    },
    strict
  ),
};
const local = wireObject(
  {
    ...shared,
    mode: wireLiteral("local"),
    operation: wireLiteral("start"),
    condition: wireLiteral("fresh-local-v1"),
    target: nil,
    execution: wireObject({ ...execution, imageDigest: nil }, strict),
    observation: wireObject(
      {
        ...observation,
        stage: wireEnum(["prepare", "execute"]),
        admissionMs: nil,
        localPreparationMs: milliseconds,
        localRecipeMs: milliseconds,
      },
      strict
    ),
    hostedMeasurements: nil,
  },
  strict
);
const cloud = wireObject(
  {
    ...shared,
    mode: wireEnum(["cloud", "cloud-fixture"]),
    operation: wireEnum(["start", "resume", "replay"]),
    condition: wireLiteral("cloud-portable-v1"),
    target,
    execution: wireObject({ ...execution, imageDigest: nullable(imageDigest) }, strict),
    observation: wireObject(
      {
        ...observation,
        stage: wireEnum(["prepare", "submit", "follow", "inspect"]),
        admissionMs: milliseconds,
        localPreparationMs: nil,
        localRecipeMs: nil,
      },
      strict
    ),
    hostedMeasurements: nullable(hostedMeasurements),
  },
  strict
);

export type Target = InferWireSchema<typeof target>;
export type LocalSample = InferWireSchema<typeof local>;
export type CloudSample = InferWireSchema<typeof cloud>;
export type Sample = LocalSample | CloudSample;
export type Checkpoint = () => Promise<void>;

type Trial = { attemptId: string; workload: Workload };
type LocalIntent = Trial & Pick<LocalSample, "mode" | "operation" | "target">;
type CloudIntent = Trial & Pick<CloudSample, "mode" | "operation" | "target">;
type Driver = Pick<Sample["tools"], "driverBun" | "driverTubeless">;

export function newSample(
  intent: LocalIntent,
  tools: Driver,
  deadlineMs: number,
  runId: null
): LocalSample;
export function newSample(
  intent: CloudIntent,
  tools: Driver,
  deadlineMs: number,
  runId: string | null
): CloudSample;
export function newSample(
  intent: LocalIntent | CloudIntent,
  tools: Driver,
  deadlineMs: number,
  runId: string | null
) {
  return readSample({
    ...intent,
    version: 1,
    invocationId: randomUUID(),
    startedAt: new Date().toISOString(),
    condition: intent.mode === "local" ? "fresh-local-v1" : "cloud-portable-v1",
    client: {
      platform: process.platform,
      arch: process.arch,
      osRelease: release(),
      cpuModel: cpus()[0]?.model || "unknown",
      logicalCpus: availableParallelism(),
      memoryBytes: totalmem(),
    },
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
  });
}

export function matchesHostedIdentity(
  { identity: measured }: HostedMeasurements,
  expected: Workload,
  image: string | null
): boolean {
  return [
    [measured.sourceCommit, expected.commit],
    [measured.sourceTree, expected.treeSha],
    [measured.lockfileDigest, expected.lockfileDigest],
    [measured.planDigest, expected.planDigest],
    [measured.imageDigest, image],
  ].every(([actual, pinned]) => actual === null || actual === pinned);
}

export function readSample(value: unknown): Sample {
  const sample =
    value && typeof value === "object" && "mode" in value && value.mode === "local"
      ? local.decode(value, "sample")
      : cloud.decode(value, "sample");
  const { execution, observation } = sample;
  if (
    sample.mode !== "cloud-fixture" &&
    !isDeepStrictEqual(sample.workload, selectWorkload(sample.workload.id, sample.workload.variant))
  )
    throw new Error("Sample workload differs from the pinned workload");
  if (execution.runId === null && execution.outcome !== "unknown")
    throw new Error("Execution outcome requires a run ID");
  if (
    observation.state === "observed" &&
    (execution.identity !== "verified" ||
      execution.outcome === "unknown" ||
      (sample.operation === "start" && observation.terminalMs === null))
  )
    throw new Error("Observed sample requires verified terminal evidence");
  if (sample.mode !== "local") {
    if (
      sample.target.idempotencyKey !== "node-check-bench:" + sample.attemptId ||
      (sample.observation.stage !== "prepare" && sample.target.principalId === null)
    )
      throw new Error("Cloud sample has no bound admission intent");
    if (sample.operation !== "start" && observation.terminalMs !== null)
      throw new Error("Cloud recovery cannot measure original client latency");
    if (
      sample.hostedMeasurements &&
      !matchesHostedIdentity(sample.hostedMeasurements, sample.workload, execution.imageDigest)
    )
      throw new Error("Cloud measurement identity conflicts with sample workload");
  }
  return sample;
}
