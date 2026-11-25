import { canonicalJsonValue } from "../../dist/utilities/canonical-json.js";
import { hostedPhases } from "./measurements.ts";
import type { Sample } from "./sample.ts";

type Counts = Record<string, number>;

function increment(counts: Counts, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

function distribution(values: number[], eligible: number) {
  values.sort((a, b) => a - b);
  const n = values.length,
    middle = Math.floor(n / 2);
  return {
    n,
    unknown: eligible - n,
    min: values[0] ?? null,
    median: n === 0 ? null : n % 2 ? values[middle] : values[middle - 1] / 2 + values[middle] / 2,
    max: values.at(-1) ?? null,
  };
}

function exclusion({ mode, operation, workload, observation, execution }: Sample) {
  if (mode === "cloud-fixture") return "fixture";
  if (operation !== "start") return operation;
  if (execution.identity === "mismatch") return "identity-mismatch";
  if (observation.state !== "observed") return observation.state;
  const expected = workload.variant === "pass" ? "passed" : "assertion-failure";
  if (execution.outcome !== expected) return "unexpected-outcome";
  return null;
}

function dimensions(sample: Sample) {
  return {
    mode: sample.mode,
    workload: sample.workload,
    condition: sample.condition,
    client: sample.client,
    tools: sample.tools,
    deadlineMs: sample.observation.deadlineMs,
    target: sample.target && {
      host: sample.target.host,
      workspace: sample.target.workspace,
      pipelineId: sample.target.pipelineId,
    },
    imageDigest: sample.execution.imageDigest,
    hostedCatalogToolchain: sample.hostedMeasurements?.identity.toolchain ?? null,
    hostedResources: sample.hostedMeasurements?.identity.resources ?? null,
  };
}

function summarizeGroup(samples: Sample[]) {
  const observationStates: Counts = {},
    outcomes: Counts = {},
    excluded: Counts = {};
  const eligible: Sample[] = [];
  for (const sample of samples) {
    increment(observationStates, sample.observation.state);
    increment(outcomes, sample.execution.outcome);
    const reason = exclusion(sample);
    if (reason) increment(excluded, reason);
    else eligible.push(sample);
  }
  const measurements: Record<string, number[]> = {};
  const add = (name: string, value: number | null) => {
    measurements[name] ??= [];
    if (value !== null) measurements[name].push(value);
  };
  const local = samples[0].mode === "local";
  for (const sample of eligible) {
    const { observation, hostedMeasurements } = sample;
    add("client.terminal", observation.terminalMs);
    if (local) {
      add("local.preparation", observation.localPreparationMs);
      add("local.recipe", observation.localRecipeMs);
    } else {
      add("client.admission", observation.admissionMs);
      for (const name of hostedPhases) {
        const phase = hostedMeasurements?.phases[name];
        if (phase)
          add("hosted." + name + "." + phase.provenance + "." + phase.kind, phase.durationMs);
      }
    }
  }
  return {
    dimensions: dimensions(samples[0]),
    invocations: samples.length,
    eligible: eligible.length,
    observationStates,
    outcomes,
    excluded,
    hostedPhaseCoverage: local
      ? null
      : Object.fromEntries(
          hostedPhases.map((name) => [
            name,
            {
              known: eligible.filter((sample) => sample.hostedMeasurements?.phases[name] != null)
                .length,
              total: eligible.length,
            },
          ])
        ),
    distributionsMs: Object.fromEntries(
      Object.entries(measurements)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, values]) => [name, distribution(values, eligible.length)])
    ),
  };
}

export function summarize(raw: Sample[]) {
  const byInvocation = new Set<string>();
  const starts = new Set<string>();
  const groups = new Map<string, Sample[]>();
  for (const sample of [...raw].sort((a, b) => a.invocationId.localeCompare(b.invocationId))) {
    if (
      byInvocation.has(sample.invocationId) ||
      (sample.operation === "start" && starts.has(sample.attemptId))
    )
      throw new Error("Duplicate benchmark sample or trial.");
    byInvocation.add(sample.invocationId);
    if (sample.operation === "start") starts.add(sample.attemptId);
    const key = JSON.stringify(canonicalJsonValue(dimensions(sample)));
    const group = groups.get(key) ?? [];
    group.push(sample);
    groups.set(key, group);
  }
  return {
    version: 1,
    invocations: raw.length,
    trials: new Set(raw.map(({ attemptId }) => attemptId)).size,
    groups: [...groups.keys()].sort().map((key) => summarizeGroup(groups.get(key)!)),
  };
}
