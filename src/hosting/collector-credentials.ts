import type { HostedAttemptDefinition } from "./attempt-store.js";
import type { StoredCollectorCredential, HostedCollectorStore } from "./collector-store.js";

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
  const secret = hex(crypto.getRandomValues(new Uint8Array(32)));
  const record = {
    credentialId: hex(crypto.getRandomValues(new Uint8Array(16))),
    launchId: attempt.launchId,
    attemptId: attempt.attemptId,
    notBeforeMs: attempt.createdAtMs,
    expiresAtMs,
  };
  const verifier = hex(
    new Uint8Array(await crypto.subtle.sign("HMAC", await key(secret, ["sign"]), context(record)))
  );
  await store.provisionCollectorAttempt(attempt, { ...record, verifier });
  return `${record.credentialId}.${secret}`;
}

/** Use native HMAC verification instead of comparing secret-dependent strings in JavaScript. */
export async function verifyCollectorCredential(
  token: string,
  record: StoredCollectorCredential,
  nowMs: number
): Promise<boolean> {
  if (
    !/^[a-f0-9]{32}\.[a-f0-9]{64}$/.test(token) ||
    !/^[a-f0-9]{64}$/.test(record.verifier) ||
    token.slice(0, 32) !== record.credentialId ||
    nowMs < record.notBeforeMs ||
    nowMs >= record.expiresAtMs
  )
    return false;
  return crypto.subtle.verify(
    "HMAC",
    await key(token.slice(33), ["verify"]),
    unhex(record.verifier),
    context(record)
  );
}
