import {
  wireEnum,
  wireLiteral,
  wireNumber,
  wireObject,
  wireRefine,
  wireString,
  wireUnion,
  type InferWireSchema,
  type WireSchema,
} from "../../dist/tracing/wire-schema.js";

export function nullable<T>(schema: WireSchema<T>): WireSchema<T | null> {
  return wireUnion([wireLiteral(null), schema]);
}

export function pattern(regex: RegExp) {
  return wireRefine(wireString(), (value, path) => {
    if (!regex.test(value)) throw new Error(path + " has an invalid format");
  });
}

export const identifier = pattern(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
export const gitSha = pattern(/^[a-f0-9]{40}$/);
export const digest = pattern(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/);
export const imageDigest = pattern(/^sha256:[a-f0-9]{64}$/);
export const version = pattern(/^[0-9]{1,8}\.[0-9]{1,8}\.[0-9]{1,8}(?:[-+][A-Za-z0-9.+-]{1,64})?$/);
export const positiveInteger = wireNumber({ integer: true, minimum: 1 });
export const milliseconds = nullable(wireNumber({ minimum: 0 }));

const phase = nullable(
  wireObject(
    {
      durationMs: wireNumber({ minimum: 0 }),
      kind: wireEnum(["observed", "derived"]),
      provenance: wireEnum([
        "workspace",
        "control-observer",
        "repository-supervisor",
        "guest-trace",
      ]),
    },
    { strict: true }
  )
);
const phases = {
  admission: phase,
  workspaceQueue: phase,
  sourceArchive: phase,
  supervisorQueue: phase,
  providerStartup: phase,
  guestPreparation: phase,
  dependencyInstallation: phase,
  execution: phase,
  completion: phase,
  supervisorCleanup: phase,
};
const cleanup = wireEnum(["pending", "done", "unavailable"]);

export const hostedMeasurements = wireObject(
  {
    version: wireLiteral(1),
    identity: wireObject(
      {
        sourceCommit: nullable(gitSha),
        sourceTree: nullable(gitSha),
        lockfileDigest: nullable(digest),
        planDigest: nullable(digest),
        imageDigest: nullable(imageDigest),
        toolchain: nullable(
          wireObject({ node: version, bun: version, runtime: version }, { strict: true })
        ),
        resources: nullable(
          wireObject(
            {
              vcpu: positiveInteger,
              memoryMib: positiveInteger,
              diskMb: positiveInteger,
            },
            { strict: true }
          )
        ),
      },
      { strict: true }
    ),
    phases: wireObject(phases, { strict: true }),
    cleanup: wireObject({ supervisor: cleanup, sourceArchive: cleanup }, { strict: true }),
    outcome: nullable(wireEnum(["completed", "failed", "cancelled", "interrupted", "timed_out"])),
  },
  { strict: true }
);

export type HostedMeasurements = InferWireSchema<typeof hostedMeasurements>;
export const hostedPhases = Object.keys(phases) as (keyof typeof phases)[];
