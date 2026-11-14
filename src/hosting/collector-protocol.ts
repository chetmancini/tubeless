import {
  wireObject,
  wireString,
  wireBoolean,
  wireOptional,
  type WireSchema,
} from "../tracing/wire-schema.js";

export const COLLECTOR_BATCH_BYTES = 1_048_576;
export const COLLECTOR_BATCH_EVENTS = 50;
export const COLLECTOR_CLAIM_BYTES = 8192;
export const COLLECTOR_FAILURE_BYTES = 65_536;
export const COLLECTOR_MESSAGE_BYTES = 8192;
export const COLLECTOR_RESPONSE_BYTES = 8192;
const collectorId = wireString({ maxLength: 256 });
export const claimSchema = wireObject({
  attemptId: collectorId,
  deploymentId: collectorId,
});
export const failureSchema = wireObject({
  attemptId: collectorId,
  failureId: collectorId,
  message: wireString({ allowEmpty: true }),
});
export const claimReplySchema = wireObject({ admitted: wireBoolean() });
export const batchReplySchema = wireObject({
  accepted: wireBoolean(),
  runId: wireOptional(collectorId),
});
export const failureReplySchema = wireObject({ recorded: wireBoolean() });

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

/** Strict request envelopes; trace-event compatibility remains with the canonical decoder. */
export function decodeCollectorJson<T extends object>(body: Uint8Array, schema: WireSchema<T>): T {
  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error();
    const decoded = schema.decode(value, "request");
    if (Object.keys(value).some((key) => !Object.hasOwn(decoded, key))) throw new Error();
    return decoded;
  } catch {
    throw new CollectorInputError();
  }
}

export async function digestCollectorBody(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
