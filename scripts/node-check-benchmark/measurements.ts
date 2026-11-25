export const hostedPhases = [
  "admission",
  "workspaceQueue",
  "sourceArchive",
  "supervisorQueue",
  "providerStartup",
  "guestPreparation",
  "dependencyInstallation",
  "execution",
  "completion",
  "supervisorCleanup",
] as const;

const provenance = [
  "workspace",
  "control-observer",
  "repository-supervisor",
  "guest-trace",
] as const;
const phaseKinds = ["observed", "derived"] as const;
const cleanupStates = ["pending", "done", "unavailable"] as const;
const hostedOutcomes = ["completed", "failed", "cancelled", "interrupted", "timed_out"] as const;

type Phase = {
  durationMs: number;
  kind: (typeof phaseKinds)[number];
  provenance: (typeof provenance)[number];
};

export type HostedMeasurements = {
  version: 1;
  identity: {
    sourceCommit: string | null;
    sourceTree: string | null;
    lockfileDigest: string | null;
    planDigest: string | null;
    imageDigest: string | null;
    toolchain: { node: string; bun: string; runtime: string } | null;
    resources: { vcpu: number; memoryMib: number; diskMb: number } | null;
  };
  phases: Record<(typeof hostedPhases)[number], Phase | null>;
  cleanup: {
    supervisor: (typeof cleanupStates)[number];
    sourceArchive: (typeof cleanupStates)[number];
  };
  outcome: (typeof hostedOutcomes)[number] | null;
};

export const sha = /^[0-9a-f]{40}$/;
export const digest = /^[A-Za-z0-9_-]{43}$/;
export const imageDigest = /^sha256:[0-9a-f]{64}$/;
export const version = /^[0-9]{1,8}\.[0-9]{1,8}\.[0-9]{1,8}(?:[-+][A-Za-z0-9.+-]{1,64})?$/;
export const id = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function matches(value: unknown, pattern: RegExp): value is string {
  return typeof value === "string" && pattern.test(value);
}

export function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function shape(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    object(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

export function oneOf<T extends string>(value: unknown, choices: readonly T[]): value is T {
  return choices.some((choice) => choice === value);
}

export function duration(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function hostedIdentity(value: unknown): boolean {
  return (
    shape(value, [
      "sourceCommit",
      "sourceTree",
      "lockfileDigest",
      "planDigest",
      "imageDigest",
      "toolchain",
      "resources",
    ]) &&
    (value.sourceCommit === null || matches(value.sourceCommit, sha)) &&
    (value.sourceTree === null || matches(value.sourceTree, sha)) &&
    (value.lockfileDigest === null || matches(value.lockfileDigest, digest)) &&
    (value.planDigest === null || matches(value.planDigest, digest)) &&
    (value.imageDigest === null || matches(value.imageDigest, imageDigest)) &&
    (value.toolchain === null ||
      (shape(value.toolchain, ["node", "bun", "runtime"]) &&
        Object.values(value.toolchain).every((tool) => matches(tool, version)))) &&
    (value.resources === null ||
      (shape(value.resources, ["vcpu", "memoryMib", "diskMb"]) &&
        Object.values(value.resources).every(positiveInteger)))
  );
}

export function isHostedMeasurements(value: unknown): value is HostedMeasurements {
  return (
    shape(value, ["version", "identity", "phases", "cleanup", "outcome"]) &&
    value.version === 1 &&
    hostedIdentity(value.identity) &&
    shape(value.phases, hostedPhases) &&
    Object.values(value.phases).every(
      (phase) =>
        phase === null ||
        (shape(phase, ["durationMs", "kind", "provenance"]) &&
          duration(phase.durationMs) &&
          oneOf(phase.kind, phaseKinds) &&
          oneOf(phase.provenance, provenance))
    ) &&
    shape(value.cleanup, ["supervisor", "sourceArchive"]) &&
    oneOf(value.cleanup.supervisor, cleanupStates) &&
    oneOf(value.cleanup.sourceArchive, cleanupStates) &&
    (value.outcome === null || oneOf(value.outcome, hostedOutcomes))
  );
}
