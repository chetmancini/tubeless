import {
  wireObject,
  wireString,
  wireBoolean,
  wireLiteral,
  type WireSchema,
} from "../../tracing/wire-schema.js";
import { MAX_ATTEMPT_ID_LENGTH } from "../attempt/store.js";

export const COLLECTOR_BATCH_BYTES = 1_048_576;
export const COLLECTOR_BATCH_EVENTS = 50;
export const COLLECTOR_CLAIM_BYTES = 8192;
export const COLLECTOR_CONTROL_BYTES = 8192;
export const COLLECTOR_FAILURE_BYTES = 65_536;
export const COLLECTOR_MESSAGE_BYTES = 8192;
export const COLLECTOR_RESPONSE_BYTES = 8192;
export const collectorId = wireString({ maxLength: MAX_ATTEMPT_ID_LENGTH });

export const COLLECTOR_CREDENTIAL_ID_BYTES = 16;
export const COLLECTOR_SECRET_BYTES = 32;
const credentialIdPattern = `[a-f0-9]{${COLLECTOR_CREDENTIAL_ID_BYTES * 2}}`;
const secretPattern = `[a-f0-9]{${COLLECTOR_SECRET_BYTES * 2}}`;
const credentialId = new RegExp(`^${credentialIdPattern}$`);
const credentialToken = new RegExp(`^(${credentialIdPattern})\\.(${secretPattern})$`);
const credentialVerifier = /^[a-f0-9]{64}$/;

export function isCollectorCredentialId(value: unknown): value is string {
  return typeof value === "string" && credentialId.test(value);
}

export function isCollectorVerifier(value: unknown): value is string {
  return typeof value === "string" && credentialVerifier.test(value);
}

export function parseCollectorToken(value: string | null | undefined) {
  const match = typeof value === "string" ? credentialToken.exec(value) : null;
  return match ? { credentialId: match[1], secret: match[2] } : undefined;
}

export function encodeCollectorToken(credentialId: string, secret: string): string {
  return `${credentialId}.${secret}`;
}

export const claimSchema = wireObject(
  { attemptId: collectorId, deploymentId: collectorId },
  { strict: true }
);
export const failureSchema = wireObject(
  { attemptId: collectorId, failureId: collectorId, message: wireString({ allowEmpty: true }) },
  { strict: true }
);
export const controlSchema = wireObject({ attemptId: collectorId }, { strict: true });
export const controlReplySchema = wireObject({ cancelRequested: wireBoolean() }, { strict: true });
export const claimReplySchema = wireObject({ admitted: wireBoolean() }, { strict: true });
export const batchReplySchema = wireObject(
  { accepted: wireLiteral(true), runId: collectorId },
  { strict: true }
);
export const failureReplySchema = wireObject({ recorded: wireBoolean() }, { strict: true });

export class CollectorRequestError extends Error {
  constructor(
    readonly status: number,
    readonly retryable: boolean
  ) {
    super(
      status === 0
        ? "Collector delivery could not be confirmed."
        : `Collector request failed (${status}).`
    );
    this.name = "CollectorRequestError";
  }
}

/** Outgoing failure messages are bounded before client state changes or delivery starts. */
export function assertCollectorFailureMessage(message: string): void {
  if (new TextEncoder().encode(message).byteLength > COLLECTOR_MESSAGE_BYTES)
    throw new CollectorRequestError(413, false);
}

export class CollectorInputError extends Error {
  constructor(readonly status = 400) {
    super(status === 413 ? "Collector request body is too large." : "Invalid collector request.");
  }
}
export class CollectorAuthorityError extends Error {
  constructor() {
    super("Invalid collector authority.");
  }
}

/** Sanitize wire diagnostics; envelope strictness belongs to each declared schema. */
export function decodeCollectorJson<T>(body: Uint8Array, schema: WireSchema<T>): T {
  try {
    return schema.decode(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)),
      "request"
    );
  } catch {
    throw new CollectorInputError();
  }
}
