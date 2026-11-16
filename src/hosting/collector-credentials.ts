import type { HostedAttemptDefinition } from "./attempt-store.js";
import type { StoredCollectorCredential, HostedCollectorStore } from "./collector-store.js";
import {
  COLLECTOR_CREDENTIAL_ID_BYTES,
  COLLECTOR_SECRET_BYTES,
  encodeCollectorToken,
  isCollectorVerifier,
  parseCollectorToken,
} from "./collector-protocol.js";

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
const unhex = (value: string) =>
  Uint8Array.from(value.match(/../g) ?? [], (pair) => parseInt(pair, 16));
const context = (record: Omit<StoredCollectorCredential, "verifier">) =>
  new TextEncoder().encode(
    JSON.stringify([
      1,
      record.credentialId,
      record.launchId,
      record.attemptId,
      record.notBeforeMs,
      record.expiresAtMs,
    ])
  );
const key = (secret: string, usage: KeyUsage[]) =>
  crypto.subtle.importKey("raw", unhex(secret), { name: "HMAC", hash: "SHA-256" }, false, usage);

/** Issue one scoped credential and persist only its verifier, atomically with the new attempt. */
export async function provisionCollectorAttempt(
  store: HostedCollectorStore,
  definition: HostedAttemptDefinition,
  expiresAtMs: number
): Promise<string> {
  const attempt = { ...definition };
  const secret = hex(crypto.getRandomValues(new Uint8Array(COLLECTOR_SECRET_BYTES)));
  const record = {
    credentialId: hex(crypto.getRandomValues(new Uint8Array(COLLECTOR_CREDENTIAL_ID_BYTES))),
    launchId: attempt.launchId,
    attemptId: attempt.attemptId,
    notBeforeMs: attempt.createdAtMs,
    expiresAtMs,
  };
  const verifier = hex(
    new Uint8Array(await crypto.subtle.sign("HMAC", await key(secret, ["sign"]), context(record)))
  );
  await store.provisionCollectorAttempt(attempt, { ...record, verifier });
  return encodeCollectorToken(record.credentialId, secret);
}

/** Use native HMAC verification instead of comparing secret-dependent strings in JavaScript. */
export async function verifyCollectorCredential(
  token: string,
  record: StoredCollectorCredential,
  nowMs: number
): Promise<boolean> {
  const parsed = parseCollectorToken(token);
  if (
    !parsed ||
    !isCollectorVerifier(record.verifier) ||
    parsed.credentialId !== record.credentialId ||
    nowMs < record.notBeforeMs ||
    nowMs >= record.expiresAtMs
  )
    return false;
  return crypto.subtle.verify(
    "HMAC",
    await key(parsed.secret, ["verify"]),
    unhex(record.verifier),
    context(record)
  );
}
