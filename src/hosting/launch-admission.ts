import {
  parseStudioLaunchRequest,
  type PipelineRunStudioLaunchRequest,
} from "../studio/shared/protocol.js";
import { canonicalJsonValue } from "../utilities/canonical-json.js";
import { parseHostedLaunch, type HostedCommand, type HostedOutput } from "./hosting-commands.js";
import type { RunJob } from "./run-contract.js";

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
  readonly deploymentId: string;
  readonly idempotencyKey: string;
}

export interface StoredLaunchAdmission {
  readonly launchId: string;
  readonly commandId: string;
  readonly intentDigest: string;
  readonly deploymentId: string;
}

export interface HostedLaunchReservation extends StoredLaunchAdmission {
  readonly idempotencyKey: string;
  readonly createdAtMs: number;
}

/** Reservation and its launch creation commit together; only the creator may dispatch. */
export interface HostedLaunchAdmissionStore {
  get(idempotencyKey: string): Promise<StoredLaunchAdmission | undefined>;
  reserve(
    request: HostedLaunchReservation
  ): Promise<{ created: boolean; admission: StoredLaunchAdmission }>;
}

export function isLaunchIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9._:-]{1,200}$/.test(value);
}

function invalid(errors: readonly string[]): HostedLaunchResult {
  return { accepted: false, code: "invalid_launch", errors };
}

function conflict(launchId: string): HostedLaunchResult {
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
  scheduleReconcile(newLaunchAtMs: number): Promise<void>;
  start(job: RunJob): Promise<void>;
}): (request: HostedLaunchRequest) => Promise<HostedLaunchResult> {
  const { projectId, deploymentId, output, store, maxRunDurationMs } = input;
  const commands = new Map(input.commands);
  const now = input.now ?? Date.now;
  const scheduleReconcile = input.scheduleReconcile.bind(input);
  const start = input.start.bind(input);
  return async ({
    commandId,
    values,
    idempotencyKey,
    projectId: requestedProject,
    deploymentId: requestedDeployment,
  }) => {
    if (!isLaunchIdentifier(idempotencyKey))
      return invalid([
        "An idempotency key must contain 1–200 letters, digits, periods, underscores, colons or hyphens.",
      ]);
    if (!deploymentId || requestedDeployment !== deploymentId || requestedProject !== projectId)
      return invalid([
        "The Worker and Studio must use the same configured project and deploymentId.",
      ]);
    const request = parseStudioLaunchRequest({ values: structuredClone(values) });
    if (!request)
      return invalid(["Launch values must use the supported bounded command parameter shapes."]);
    const previous = await store.get(idempotencyKey);
    if (previous && (previous.commandId !== commandId || previous.deploymentId !== deploymentId))
      return conflict(previous.launchId);
    const parsed = parseHostedLaunch(commands.get(commandId), request.values, output);
    if ("errors" in parsed) return previous ? conflict(previous.launchId) : invalid(parsed.errors);
    const resolved = parseStudioLaunchRequest({ values: structuredClone(parsed.values) });
    if (!resolved)
      return invalid([
        "Normalized launch values must use the supported bounded command parameter shapes.",
      ]);
    const normalized = normalizedValues(resolved.values);
    const bytes = new TextEncoder().encode(
      JSON.stringify(
        canonicalJsonValue({
          projectId,
          commandId,
          values: normalized,
          maxRunDurationMs,
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
    if (!previous) await scheduleReconcile(createdAtMs);
    const reservation = previous
      ? { created: false, admission: previous }
      : await store.reserve({
          idempotencyKey,
          intentDigest,
          deploymentId,
          commandId,
          createdAtMs,
          launchId: crypto.randomUUID(),
        });
    const { admission } = reservation;
    if (admission.intentDigest !== intentDigest || admission.deploymentId !== deploymentId)
      return conflict(admission.launchId);
    if (reservation.created)
      await start({
        launchId: admission.launchId,
        commandId,
        values: normalized,
        deploymentId,
        maxRunDurationMs,
      });
    return { accepted: true, launchId: admission.launchId };
  };
}
