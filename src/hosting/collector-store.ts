import type { HostedAttemptDefinition, AttemptBatchAcknowledgement } from "./attempt-store.js";

export interface CollectorCredential {
  readonly credentialId: string;
  /** HMAC verifier; the randomly generated bearer secret is never persisted. */
  readonly verifier: string;
  readonly notBeforeMs: number;
  readonly expiresAtMs: number;
}
export interface StoredCollectorCredential extends CollectorCredential {
  readonly launchId: string;
  readonly attemptId: string;
}
/** Verified by the HTTP authenticator; persistence rechecks this snapshot at commit time. */
export type CollectorAuthorization = Pick<
  StoredCollectorCredential,
  "credentialId" | "launchId" | "attemptId" | "verifier"
>;

export interface HostedCollectorStore {
  provisionCollectorAttempt(
    definition: HostedAttemptDefinition,
    credential: CollectorCredential
  ): Promise<void>;
  getCollectorCredential(
    launchId: string,
    credentialId: string
  ): Promise<StoredCollectorCredential | undefined>;
  claimCollectorAttempt(
    authority: CollectorAuthorization,
    workerId: string,
    deploymentId: string
  ): Promise<boolean>;
  /** Read persisted intent only for the claiming worker; recheck authority at the storage boundary. */
  collectorCancellationRequested(
    authority: CollectorAuthorization,
    workerId: string
  ): Promise<boolean>;
  acceptCollectorBatch(
    authority: CollectorAuthorization,
    workerId: string,
    body: Uint8Array
  ): Promise<AttemptBatchAcknowledgement>;
  /** Only report after owned execution has exited/drained; connectivity loss is not termination. */
  reportCollectorFailure(
    authority: CollectorAuthorization,
    workerId: string,
    body: Uint8Array
  ): Promise<boolean>;
}
