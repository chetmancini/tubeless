import { digestCanonicalJson, isJsonObject } from "../canonical-json.js";
import { exactFields, isDigest } from "./data.js";
import {
  decodeNodeCheckFileInventory,
  decodeNodeCheckFileRequest,
  digestNodeCheckFileInventory,
  digestNodeCheckFileRequest,
  isNodeCheckFilePath,
  normalizeNodeCheckFiles,
  type NodeCheckFileInventory,
  type NodeCheckFileRequest,
} from "./files.js";

type PartitionRequest = Exclude<NodeCheckFileRequest, { mode: "inventory" }>;
type TimingMetric = "vitest-module-tests-and-hooks" | "sum-of-final-test-durations";

/** Producer-verified digests of source, effective configuration and execution environment. */
export interface NodeCheckPartitionTimingContext {
  sourceDigest: string;
  configurationDigest: string;
  environmentDigest: string;
}

/** One historical file measurement with explicit eligibility, metric and provenance. */
export interface NodeCheckPartitionTimingObservation {
  path: string;
  sampleId: string;
  metric: TimingMetric;
  durationMs: number | null;
  contextDigest: string | null;
  identity: "unique-specification" | "report-path";
  /** Attests accepted, complete, successful and unambiguous evidence from the producer. */
  eligible: boolean;
}

type Fallback = "missing" | "incompatible-context" | "unusable-observation";
type FileEstimate = {
  path: string;
  estimatedMs: number;
  estimate:
    | { kind: "timing"; metric: TimingMetric; sampleId: string }
    | { kind: "fallback"; reason: Fallback };
};

/** Canonical v1 assignment for an explicit Vitest file cohort and complete inventory. */
export interface NodeCheckPartitionPlan {
  version: 1;
  inventory: NodeCheckFileInventory;
  inventoryDigest: string;
  request: PartitionRequest;
  requestDigest: string;
  timingContext: NodeCheckPartitionTimingContext | null;
  timingContextDigest: string | null;
  partitions: { id: number; estimatedMs: number; files: FileEstimate[] }[];
}

/** Logical limits for v1 partition planning, independent of any transport's smaller limits. */
export const NODE_CHECK_PARTITION_LIMITS = Object.freeze({
  partitions: 16,
  observations: 8192,
  durationMs: 86_400_000,
  planBytes: 4 * 1024 * 1024,
} as const);

const fallbackMinimumMs = 1000;
const sampleIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function timingMetric(value: unknown): value is TimingMetric {
  return value === "vitest-module-tests-and-hooks" || value === "sum-of-final-test-durations";
}

function duration(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= NODE_CHECK_PARTITION_LIMITS.durationMs
  );
}

function decodeTimingContext(value: unknown): NodeCheckPartitionTimingContext {
  const { sourceDigest, configurationDigest, environmentDigest } = exactFields(
    value,
    ["sourceDigest", "configurationDigest", "environmentDigest"],
    "partition timing context"
  );
  if (!isDigest(sourceDigest) || !isDigest(configurationDigest) || !isDigest(environmentDigest))
    throw new TypeError("Partition timing context requires three verified digests.");
  return { sourceDigest, configurationDigest, environmentDigest };
}

function digestTimingContext(inventoryDigest: string, context: NodeCheckPartitionTimingContext) {
  return digestCanonicalJson({ version: 1, inventoryDigest, context });
}

/** Hash a verified timing context together with the complete canonical inventory identity. */
export async function digestNodeCheckPartitionTimingContext(
  inventory: NodeCheckFileInventory,
  context: NodeCheckPartitionTimingContext
): Promise<string> {
  const verified = decodeTimingContext(context);
  const inventoryDigest = await digestNodeCheckFileInventory(
    decodeNodeCheckFileInventory(inventory)
  );
  return digestTimingContext(inventoryDigest, verified);
}

async function bind(
  rawInventory: unknown,
  rawRequest: unknown,
  rawContext: unknown
): Promise<Omit<NodeCheckPartitionPlan, "partitions">> {
  const inventory = decodeNodeCheckFileInventory(rawInventory);
  const request = decodeNodeCheckFileRequest(rawRequest);
  if (request.mode === "inventory" || request.stepId !== inventory.stepId)
    throw new TypeError("Partition request must select files for the inventoried Vitest step.");
  const files = new Set(inventory.files);
  if (request.mode === "selected" && request.files.some((path) => !files.has(path)))
    throw new TypeError("Partition request contains an unknown Vitest file.");
  const timingContext = rawContext === null ? null : decodeTimingContext(rawContext);
  const inventoryDigest = await digestNodeCheckFileInventory(inventory);
  return {
    version: 1,
    inventory,
    inventoryDigest,
    request,
    requestDigest: await digestNodeCheckFileRequest(inventory.planDigest, request),
    timingContext,
    timingContextDigest:
      timingContext && (await digestTimingContext(inventoryDigest, timingContext)),
  };
}

function cohort({
  inventory,
  request,
}: Omit<NodeCheckPartitionPlan, "partitions">): readonly string[] {
  return request.mode === "full" ? inventory.files : request.files;
}

function partitionCount(value: unknown, files: readonly string[]): number {
  if (!files.length) throw new TypeError("Cannot partition an empty Vitest file cohort.");
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > NODE_CHECK_PARTITION_LIMITS.partitions ||
    value > files.length
  )
    throw new TypeError(
      "Partition count must be between 1 and 16 and cannot exceed the file count."
    );
  return value;
}

function decodeObservation(value: unknown): NodeCheckPartitionTimingObservation {
  const { path, sampleId, metric, durationMs, contextDigest, identity, eligible } = exactFields(
    value,
    ["path", "sampleId", "metric", "durationMs", "contextDigest", "identity", "eligible"],
    "partition timing observation"
  );
  if (
    !isNodeCheckFilePath(path) ||
    typeof sampleId !== "string" ||
    !sampleIdPattern.test(sampleId) ||
    !timingMetric(metric) ||
    (durationMs !== null && !duration(durationMs)) ||
    (contextDigest !== null && !isDigest(contextDigest)) ||
    (identity !== "unique-specification" && identity !== "report-path") ||
    typeof eligible !== "boolean"
  )
    throw new TypeError("Invalid partition timing observation.");
  return { path, sampleId, metric, durationMs, contextDigest, identity, eligible };
}

function estimateFiles(
  files: readonly string[],
  rawObservations: unknown,
  timingContextDigest: string | null
): FileEstimate[] {
  if (
    !Array.isArray(rawObservations) ||
    rawObservations.length > NODE_CHECK_PARTITION_LIMITS.observations
  )
    throw new TypeError("Invalid or oversized partition timing history.");
  const histories = new Map<string, NodeCheckPartitionTimingObservation[]>();
  const seen = new Set<string>();
  for (const raw of rawObservations) {
    const observation = decodeObservation(raw);
    const key = JSON.stringify([observation.path, observation.metric, observation.sampleId]);
    if (seen.has(key)) throw new TypeError("Duplicate partition timing observation.");
    seen.add(key);
    const history = histories.get(observation.path) ?? [];
    history.push(observation);
    histories.set(observation.path, history);
  }
  const estimates = files.map((path): FileEstimate => {
    const history = histories.get(path) ?? [];
    const compatible = history.filter(
      ({ contextDigest }) => timingContextDigest !== null && contextDigest === timingContextDigest
    );
    const usable = compatible.filter(
      (sample): sample is NodeCheckPartitionTimingObservation & { durationMs: number } =>
        sample.eligible && sample.identity === "unique-specification" && sample.durationMs !== null
    );
    const best = usable.sort(
      (a, b) =>
        Number(b.metric === "vitest-module-tests-and-hooks") -
          Number(a.metric === "vitest-module-tests-and-hooks") ||
        b.durationMs - a.durationMs ||
        compare(a.sampleId, b.sampleId)
    )[0];
    if (best)
      return {
        path,
        estimatedMs: Math.ceil(best.durationMs),
        estimate: { kind: "timing", metric: best.metric, sampleId: best.sampleId },
      };
    const reason = !history.length
      ? "missing"
      : !compatible.length
        ? "incompatible-context"
        : "unusable-observation";
    return { path, estimatedMs: 0, estimate: { kind: "fallback", reason } };
  });
  const fallback = fallbackWeight(estimates);
  for (const file of estimates) if (file.estimate.kind === "fallback") file.estimatedMs = fallback;
  return estimates;
}

function fallbackWeight(estimates: readonly FileEstimate[]): number {
  return estimates.reduce(
    (max, file) => (file.estimate.kind === "timing" ? Math.max(max, file.estimatedMs) : max),
    fallbackMinimumMs
  );
}

function assign(estimates: FileEstimate[], count: number): NodeCheckPartitionPlan["partitions"] {
  const partitions: NodeCheckPartitionPlan["partitions"] = Array.from(
    { length: count },
    (_, index) => ({
      id: index + 1,
      estimatedMs: 0,
      files: [],
    })
  );
  estimates.sort((a, b) => b.estimatedMs - a.estimatedMs || compare(a.path, b.path));
  for (const file of estimates) {
    const lightest = partitions.reduce((best, next) =>
      next.estimatedMs < best.estimatedMs ||
      (next.estimatedMs === best.estimatedMs && next.files.length < best.files.length)
        ? next
        : best
    );
    lightest.files.push(file);
    lightest.estimatedMs += file.estimatedMs;
  }
  for (const partition of partitions) partition.files.sort((a, b) => compare(a.path, b.path));
  return partitions;
}

function enforcePlanSize(plan: NodeCheckPartitionPlan): NodeCheckPartitionPlan {
  if (new TextEncoder().encode(JSON.stringify(plan)).length > NODE_CHECK_PARTITION_LIMITS.planBytes)
    throw new TypeError("Partition plan exceeds 4 MiB.");
  return plan;
}

/** Plan a deterministic versioned assignment without accessing the filesystem or executing tests. */
export async function planNodeCheckPartitions(
  inventory: NodeCheckFileInventory,
  request: PartitionRequest,
  options: {
    partitions: number;
    timingContext?: NodeCheckPartitionTimingContext;
    observations?: readonly NodeCheckPartitionTimingObservation[];
  }
): Promise<NodeCheckPartitionPlan> {
  const bound = await bind(inventory, request, options.timingContext ?? null);
  const files = cohort(bound);
  const count = partitionCount(options.partitions, files);
  const estimates = estimateFiles(files, options.observations ?? [], bound.timingContextDigest);
  return enforcePlanSize({ ...bound, partitions: assign(estimates, count) });
}

function decodeEstimate(value: unknown, timingContextDigest: string | null): FileEstimate {
  const { path, estimatedMs, estimate } = exactFields(
    value,
    ["path", "estimatedMs", "estimate"],
    "partition file estimate"
  );
  if (!isNodeCheckFilePath(path) || !duration(estimatedMs) || !Number.isInteger(estimatedMs))
    throw new TypeError("Invalid partition file estimate.");
  if (isJsonObject(estimate) && estimate.kind === "timing") {
    const { metric, sampleId } = exactFields(
      estimate,
      ["kind", "metric", "sampleId"],
      "timing estimate provenance"
    );
    if (
      !timingContextDigest ||
      !timingMetric(metric) ||
      typeof sampleId !== "string" ||
      !sampleIdPattern.test(sampleId)
    )
      throw new TypeError("Invalid partition timing provenance.");
    return { path, estimatedMs, estimate: { kind: "timing", metric, sampleId } };
  }
  const { kind, reason } = exactFields(
    estimate,
    ["kind", "reason"],
    "fallback estimate provenance"
  );
  if (
    kind !== "fallback" ||
    (reason !== "missing" && reason !== "incompatible-context" && reason !== "unusable-observation")
  )
    throw new TypeError("Invalid partition fallback provenance.");
  return { path, estimatedMs, estimate: { kind, reason } };
}

/** Verify a v1 partition envelope, bindings, exact cohort coverage and canonical assignment. */
export async function decodeNodeCheckPartitionPlan(
  value: unknown
): Promise<NodeCheckPartitionPlan> {
  const raw = exactFields(
    value,
    [
      "version",
      "inventory",
      "inventoryDigest",
      "request",
      "requestDigest",
      "timingContext",
      "timingContextDigest",
      "partitions",
    ],
    "partition plan"
  );
  if (raw.version !== 1 || !Array.isArray(raw.partitions))
    throw new TypeError("Unsupported partition plan version or members.");
  const bound = await bind(raw.inventory, raw.request, raw.timingContext);
  if (
    raw.inventoryDigest !== bound.inventoryDigest ||
    raw.requestDigest !== bound.requestDigest ||
    raw.timingContextDigest !== bound.timingContextDigest
  )
    throw new TypeError("Partition plan identity mismatch.");
  const files = cohort(bound);
  const count = partitionCount(raw.partitions.length, files);
  const estimates: FileEstimate[] = [];
  const received = Array.from(raw.partitions, (value: unknown) => {
    const entry = exactFields(value, ["id", "estimatedMs", "files"], "partition");
    const { id, estimatedMs } = entry;
    if (
      typeof id !== "number" ||
      !Number.isInteger(id) ||
      id < 1 ||
      id > count ||
      typeof estimatedMs !== "number" ||
      !Array.isArray(entry.files) ||
      !entry.files.length ||
      estimates.length + entry.files.length > files.length
    )
      throw new TypeError("Invalid partition membership.");
    const members = Array.from(entry.files, (file: unknown) =>
      decodeEstimate(file, bound.timingContextDigest)
    );
    estimates.push(...members);
    return { id, estimatedMs, files: members.sort((a, b) => compare(a.path, b.path)) };
  }).sort((a, b) => a.id - b.id);
  const union = normalizeNodeCheckFiles(estimates.map(({ path }) => path));
  if (union.length !== files.length || union.some((file, index) => file !== files[index]))
    throw new TypeError("Partition membership must cover the requested cohort exactly once.");
  const fallback = fallbackWeight(estimates);
  if (estimates.some((file) => file.estimate.kind === "fallback" && file.estimatedMs !== fallback))
    throw new TypeError("Invalid partition fallback estimate.");
  const partitions = assign(estimates, count);
  if (JSON.stringify(partitions) !== JSON.stringify(received))
    throw new TypeError("Partition assignment differs from the canonical plan.");
  return enforcePlanSize({ ...bound, partitions });
}

/** SHA-256/base64url of the validated canonical partition envelope. */
export async function digestNodeCheckPartitionPlan(plan: NodeCheckPartitionPlan): Promise<string> {
  return digestCanonicalJson(await decodeNodeCheckPartitionPlan(plan));
}
