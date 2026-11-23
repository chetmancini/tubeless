import {
  parseStudioLaunchRequest,
  type PipelineRunStudioLaunchRequest,
} from "../studio/shared/protocol.js";
import { canonicalJsonValue } from "../utilities/canonical-json.js";
import { parseHostedLaunch, type HostedCommand, type HostedOutput } from "./hosting-commands.js";
import type { RunJob } from "./run-contract.js";
import {
  launchAttributionSchema,
  type LaunchAttribution,
  type StudioLaunchMetadata,
} from "../studio/shared/launch-metadata.js";
import { recordedLaunch } from "./launch-metadata.js";
import { isLaunchIdentifier } from "./execution-status.js";

/** Structured command parameters, including built-in execution controls. */
export type HostedLaunchValues = PipelineRunStudioLaunchRequest["values"];

/** Admission is distinct from execution start and successful pipeline completion. */
export type HostedLaunchResult =
  | { readonly accepted: true; readonly launchId: string }
  | {
      readonly accepted: false;
      readonly code: "invalid_launch";
      readonly errors: readonly string[];
    }
  | {
      readonly accepted: false;
      readonly code: "idempotency_conflict";
      readonly errors: readonly string[];
      readonly launchId: string;
    };

/** Unpinned browser launches dispatch immediately. Pinned launches use the durable outbox. */
export type HostedLaunchDecision =
  | { readonly accepted: true; readonly launchId: string; readonly job: RunJob | undefined }
  | Extract<HostedLaunchResult, { accepted: false }>;

/** Current launch bookkeeping; inspect the linked run for its pipeline outcome. */
export interface HostedLaunchStatus {
  readonly launchId: string;
  readonly commandId: string;
  readonly state: "starting" | "running" | "finished" | "failed";
  readonly runId?: string;
}

/** Complete trusted request crossing the application-to-launcher boundary. */
export interface HostedLaunchRequest {
  readonly commandId: string;
  readonly values: HostedLaunchValues;
  readonly projectId: string;
  readonly deploymentId: string | undefined;
  readonly idempotencyKey: string;
  readonly context?: LaunchAttribution;
}

export interface StoredLaunchAdmission {
  readonly launchId: string;
  readonly commandId: string;
  readonly intentDigest: string;
  readonly deploymentId: string;
}

export interface HostedLaunchReservation {
  readonly idempotencyKey: string;
  readonly intentDigest: string;
  readonly createdAtMs: number;
  readonly metadata?: StudioLaunchMetadata;
  readonly job: RunJob;
}

/** Reservation, launch creation, and any outbox job commit together. */
export interface HostedLaunchAdmissionStore {
  get(idempotencyKey: string): Promise<StoredLaunchAdmission | undefined>;
  reserve(
    request: HostedLaunchReservation
  ): Promise<{ created: boolean; admission: StoredLaunchAdmission }>;
}

function invalid(
  errors: readonly string[]
): Extract<HostedLaunchResult, { code: "invalid_launch" }> {
  return { accepted: false, code: "invalid_launch", errors };
}

function conflict(launchId: string): Extract<HostedLaunchResult, { code: "idempotency_conflict" }> {
  return {
    accepted: false,
    code: "idempotency_conflict",
    launchId,
    errors: ["This idempotency key already identifies a different launch intent or deployment."],
  };
}

/** Normalize JSON numbers explicitly so the dispatched values and digest agree on negative zero. */
function normalizedValues(values: HostedLaunchValues): HostedLaunchValues {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]): readonly [string, HostedLaunchValues[string]] => {
      if (typeof value === "number") return [key, value === 0 ? 0 : value];
      if (
        typeof value === "object" &&
        value.every((item): item is number => typeof item === "number")
      )
        return [key, value.map((item) => (item === 0 ? 0 : item))];
      return [key, value];
    })
  );
}

/** Own durable submission policy independently of a platform's RPC, alarms, and SQL adapter. */
export function createHostedLaunchAdmission(input: {
  readonly projectId: string;
  readonly deploymentId: string | undefined;
  readonly commands: ReadonlyMap<string, HostedCommand>;
  readonly output: HostedOutput;
  readonly store: HostedLaunchAdmissionStore;
  readonly maxRunDurationMs: number;
  readonly now?: () => number;
  readonly recoverInterruptedRuns?: boolean;
  readonly localPipelines?: ReadonlyMap<string, string>;
  readonly inputPolicy?: ReadonlyMap<string, ReadonlySet<string>>;
}): (request: HostedLaunchRequest) => Promise<HostedLaunchDecision> {
  const { projectId, deploymentId, output, store, maxRunDurationMs } = input;
  const commands = new Map(input.commands);
  const policy = input.inputPolicy ?? new Map();
  const now = input.now ?? Date.now;
  return async ({
    commandId,
    values,
    idempotencyKey,
    projectId: requestedProject,
    deploymentId: requestedDeployment,
    context,
  }) => {
    if (!isLaunchIdentifier(idempotencyKey))
      return invalid([
        "An idempotency key must contain 1–200 letters, digits, periods, underscores, colons or hyphens.",
      ]);
    if (requestedDeployment !== deploymentId || requestedProject !== projectId)
      return invalid([
        "The Worker and Studio must use the same configured project and deploymentId.",
      ]);
    const request = parseStudioLaunchRequest({ values: structuredClone(values) });
    if (!request)
      return invalid(["Launch values must use the supported bounded command parameter shapes."]);
    let launchContext: LaunchAttribution;
    try {
      launchContext = launchAttributionSchema.decode(context ?? {}, "Launch attribution");
    } catch {
      return invalid(["Launch actor or trigger is invalid."]);
    }
    // An empty stored deployment denotes an unpinned browser launch; the public code API requires an ID.
    const storedDeployment = deploymentId ?? "";
    const previous = await store.get(idempotencyKey);
    if (
      previous &&
      (previous.commandId !== commandId || previous.deploymentId !== storedDeployment)
    )
      return conflict(previous.launchId);
    const parsed = parseHostedLaunch(commands.get(commandId), request.values, output);
    if ("errors" in parsed) return previous ? conflict(previous.launchId) : invalid(parsed.errors);
    const resolved = parseStudioLaunchRequest({ values: structuredClone(parsed.values) });
    if (!resolved)
      return invalid([
        "Normalized launch values must use the supported bounded command parameter shapes.",
      ]);
    const target = input.localPipelines?.has(commandId) ? "local" : undefined;
    const normalized = normalizedValues(resolved.values);
    const recovery =
      input.recoverInterruptedRuns && target === undefined && normalized.dryRun !== true;
    const identity = recovery
      ? commands.get(commandId)?.command.plan().definition?.identity
      : undefined;
    if (recovery && !identity?.implementationVersion)
      return invalid(["Recovery requires a versioned pipeline definition."]);
    const recoveryDefinitionId = identity?.definitionId;
    const bytes = new TextEncoder().encode(
      JSON.stringify(
        canonicalJsonValue({
          projectId,
          commandId,
          values: normalized,
          maxRunDurationMs,
          ...(target === undefined ? {} : { target }),
          ...(recoveryDefinitionId === undefined ? {} : { recoveryDefinitionId }),
        })
      )
    );
    if (bytes.byteLength > 65_536)
      return invalid(["Normalized launch intent must fit within 64 KiB."]);
    const hash = await crypto.subtle.digest("SHA-256", bytes);
    const intentDigest = Array.from(new Uint8Array(hash), (byte) =>
      byte.toString(16).padStart(2, "0")
    ).join("");
    const createdAtMs = now();
    const launchId = previous?.launchId ?? crypto.randomUUID();
    const job: RunJob = {
      launchId,
      commandId,
      values: normalized,
      deploymentId,
      target,
      recoveryDefinitionId,
      maxRunDurationMs,
    };
    const reservation = previous
      ? { created: false, admission: previous }
      : await store.reserve({
          idempotencyKey,
          intentDigest,
          createdAtMs,
          job,
          metadata: recordedLaunch(
            commands.get(commandId)!,
            normalized,
            policy.get(commandId),
            { launchId, deploymentId, target },
            launchContext
          ),
        });
    const { admission } = reservation;
    if (admission.intentDigest !== intentDigest || admission.deploymentId !== storedDeployment)
      return conflict(admission.launchId);
    return {
      accepted: true,
      launchId: admission.launchId,
      job: reservation.created && deploymentId === undefined ? job : undefined,
    };
  };
}
