import type {
  HostedCollectorStore,
  CollectorCredential,
  StoredCollectorCredential,
  CollectorAuthorization,
} from "./collector-store.js";
import {
  CollectorAuthorityError,
  CollectorInputError,
  COLLECTOR_FAILURE_BYTES,
  COLLECTOR_MESSAGE_BYTES,
  decodeCollectorJson,
  digestCollectorBody,
  failureSchema,
  isCollectorCredentialId,
  isCollectorVerifier,
} from "./collector-protocol.js";
import { decodeAttemptBatch } from "./attempt-batch.js";
import {
  HostedAttemptConflict,
  assertAttemptId,
  type AttemptBatchAcknowledgement,
  type HostedAttemptDefinition,
  type HostedAttemptOwner,
  type HostedAttemptStore,
} from "./attempt-store.js";
import type { BatchAcknowledgement, HostedLaunchStore } from "./launch-store.js";
import type { HostedLaunchAdmissionStore, HostedLaunchStatus } from "./launch-admission.js";
import { createSqliteLaunchAdmissionStore } from "./launch-admission-sqlite.js";
import { createSqliteLaunchMetadataStore } from "./launch-metadata-sqlite.js";
import type { StudioLaunchMetadata } from "../studio/shared/launch-metadata.js";
import type { PipelineRunEventQuery, PipelineRunEventReader } from "../run-store/run-store.js";
import {
  openSubtreeStartsQuery,
  storedRunEvent,
  type RunEventRecord,
} from "../run-store/run-store-sql.js";
import { PIPELINE_TRACE_VERSION } from "../tracing/tracing-constants.js";
import type { PipelineTraceEvent } from "../tracing/tracing.js";
import type { HostedFailureReason } from "./run-contract.js";
import { SqliteExecutionStore, TRUSTED_LAUNCHES } from "./execution-store-sqlite.js";

/** Synchronous SQLite port; adapter and schema initialization remain target-owned. */
export interface SqliteLaunchStorage {
  readonly sql: {
    exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] };
  };
  transactionSync<T>(fn: () => T): T;
}

/** Appends share the adapter's surrounding transaction. */
export interface LaunchEventStore {
  append(events: readonly PipelineTraceEvent[]): void;
}

type LaunchState = "starting" | "running" | "finished" | "failed";

interface LaunchRecord {
  readonly launchId: string;
  readonly commandId: string;
  readonly runId?: string;
  readonly pipelineId?: string;
  readonly dryRun: boolean;
  readonly stepCount: number;
  readonly state: LaunchState;
  readonly ownership: "trusted" | "attempt";
  /** The executor was cleared to execute user code; a start failure must not close it. */
  readonly admitted: boolean;
  readonly lastBatch: number;
}

const TERMINAL: ReadonlySet<LaunchState> = new Set(["finished", "failed"]);

type PipelineStartedEvent = Extract<PipelineTraceEvent, { name: "pipeline.started" }>;

/** A failed completion mirroring the identity core gives a run's own completion event. */
function hostTerminatedEvent(
  started: PipelineStartedEvent,
  message: string,
  nowMs: number
): PipelineTraceEvent {
  return {
    version: PIPELINE_TRACE_VERSION,
    name: "pipeline.completed",
    runId: started.runId,
    pipelineId: started.pipelineId,
    ...(started.parentRunId === undefined ? {} : { parentRunId: started.parentRunId }),
    ...(started.correlationId === undefined ? {} : { correlationId: started.correlationId }),
    ...(started.itemKey === undefined ? {} : { itemKey: started.itemKey }),
    ...(started.iteration === undefined ? {} : { iteration: started.iteration }),
    timestampMs: nowMs,
    payload: {
      dryRun: started.payload.dryRun,
      errorCount: 1,
      finalized: false,
      status: "failed",
      stepCount: started.payload.stepCount,
    },
    error: { code: "TUBELESS_RUN_CANCELLED", kind: "cancellation", message, phase: "execution" },
  };
}

/** SQLite launch/history adapter; event appends and launch transitions share one connection. */
export class SqliteHostedLaunchStore
  implements HostedLaunchStore, HostedAttemptStore, HostedCollectorStore
{
  readonly admissions: HostedLaunchAdmissionStore;
  readonly metadata: ReturnType<typeof createSqliteLaunchMetadataStore>;
  readonly executions: SqliteExecutionStore;
  constructor(
    private readonly storage: SqliteLaunchStorage,
    private readonly events: LaunchEventStore & PipelineRunEventReader,
    private readonly now: () => number = Date.now
  ) {
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS tubeless_launches (
      launch_id TEXT PRIMARY KEY,
      command_id TEXT NOT NULL,
      run_id TEXT,
      pipeline_id TEXT,
      dry_run INTEGER NOT NULL DEFAULT 0,
      step_count INTEGER NOT NULL DEFAULT 0,
      state TEXT NOT NULL,
      admitted INTEGER NOT NULL DEFAULT 0,
      last_batch INTEGER NOT NULL DEFAULT -1,
      created_at_ms INTEGER NOT NULL
    )`);
    storage.sql.exec(
      "CREATE INDEX IF NOT EXISTS tubeless_launches_run_id_idx ON tubeless_launches(run_id)"
    );
    for (const statement of [
      `CREATE TABLE IF NOT EXISTS tubeless_collector_credentials (
        attempt_id TEXT PRIMARY KEY NOT NULL,
        credential_id TEXT NOT NULL UNIQUE,
        verifier TEXT NOT NULL,
        not_before_ms INTEGER NOT NULL,
        expires_at_ms INTEGER NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS tubeless_attempt_failures (
        attempt_id TEXT NOT NULL,
        failure_id TEXT NOT NULL,
        digest TEXT NOT NULL,
        recorded INTEGER NOT NULL,
        PRIMARY KEY (attempt_id, failure_id)
      )`,
      `CREATE TABLE IF NOT EXISTS tubeless_attempt_cancellations (
        attempt_id TEXT PRIMARY KEY NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS tubeless_attempts (
        attempt_id TEXT PRIMARY KEY,
        launch_id TEXT NOT NULL UNIQUE,
        pipeline_id TEXT NOT NULL,
        deployment_id TEXT NOT NULL,
        worker_id TEXT,
        claimed_at_ms INTEGER,
        revoked INTEGER NOT NULL DEFAULT 0
      )`,
      `CREATE TABLE IF NOT EXISTS tubeless_attempt_batches (
        attempt_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        digest TEXT NOT NULL,
        run_id TEXT NOT NULL,
        PRIMARY KEY (attempt_id, sequence)
      )`,
      `CREATE TABLE IF NOT EXISTS tubeless_attempt_runs (
        run_id TEXT PRIMARY KEY,
        attempt_id TEXT NOT NULL,
        pipeline_id TEXT NOT NULL,
        parent_run_id TEXT
      )`,
    ])
      storage.sql.exec(statement);
    this.metadata = createSqliteLaunchMetadataStore(storage);
    this.executions = new SqliteExecutionStore(storage);
    this.admissions = createSqliteLaunchAdmissionStore(
      storage,
      ({ job, createdAtMs, metadata }) => {
        this.#create(job.launchId, job.commandId, createdAtMs, metadata);
        if (job.deploymentId !== undefined) this.executions.enqueue(job, createdAtMs);
      }
    );
  }

  /** Synchronous so target-owned history deletion can check eligibility in its transaction. */
  hasActiveLaunches(): boolean {
    return (
      this.storage.sql
        .exec("SELECT 1 FROM tubeless_launches WHERE state IN ('starting', 'running') LIMIT 1")
        .toArray().length > 0
    );
  }

  async create(launchId: string, commandId: string, nowMs: number): Promise<void> {
    this.#create(launchId, commandId, nowMs);
  }

  async launchStatus(launchId: string): Promise<HostedLaunchStatus | undefined> {
    const launch = this.#get(launchId);
    if (!launch || launch.ownership !== "trusted") return undefined;
    return {
      launchId,
      commandId: launch.commandId,
      state: launch.state,
      ...(launch.runId === undefined ? {} : { runId: launch.runId }),
    };
  }

  #create(
    launchId: string,
    commandId: string,
    nowMs: number,
    metadata?: StudioLaunchMetadata
  ): void {
    this.storage.sql.exec(
      "INSERT INTO tubeless_launches (launch_id, command_id, state, created_at_ms) VALUES (?, ?, 'starting', ?)",
      launchId,
      commandId,
      nowMs
    );
    if (metadata) this.metadata.record(metadata);
  }

  #get(launchId: string): LaunchRecord | undefined {
    const row = this.storage.sql
      .exec(
        `SELECT launch.*, attempt.attempt_id FROM tubeless_launches AS launch
         LEFT JOIN tubeless_attempts AS attempt ON attempt.launch_id = launch.launch_id
         WHERE launch.launch_id = ?`,
        launchId
      )
      .toArray()[0];
    if (!row) return undefined;
    return {
      launchId: String(row.launch_id),
      commandId: String(row.command_id),
      ...(row.run_id == null ? {} : { runId: String(row.run_id) }),
      ...(row.pipeline_id == null ? {} : { pipelineId: String(row.pipeline_id) }),
      dryRun: Number(row.dry_run) === 1,
      stepCount: Number(row.step_count),
      // SAFETY: state is only ever written from LaunchState literals in this class.
      state: row.state as LaunchState,
      ownership: row.attempt_id === null ? "trusted" : "attempt",
      admitted: Number(row.admitted) === 1,
      lastBatch: Number(row.last_batch),
    };
  }

  /** Clear an open launch to execute; a closed or unknown launch must never run user code. */
  async admit(launchId: string): Promise<boolean> {
    return this.storage.transactionSync(() => {
      const launch = this.#get(launchId);
      if (!launch || TERMINAL.has(launch.state) || launch.ownership === "attempt") return false;
      if (!this.executions.claim(launchId, launch.admitted)) return false;
      this.storage.sql.exec(
        "UPDATE tubeless_launches SET admitted = 1 WHERE launch_id = ?",
        launchId
      );
      return true;
    });
  }

  /**
   * Open launches require the next committed sequence. Replays return the persisted
   * root identity; closed launches reject new batches without changing that sequence.
   */
  async acceptBatch(
    launchId: string,
    sequence: number,
    events: readonly PipelineTraceEvent[]
  ): Promise<BatchAcknowledgement> {
    return this.storage.transactionSync(() => {
      const launch = this.#get(launchId);
      if (!launch) throw new Error(`Unknown launch ${JSON.stringify(launchId)}.`);
      if (launch.ownership === "attempt") throw new HostedAttemptConflict("ownership");
      if (sequence <= launch.lastBatch)
        return { accepted: true, ...(launch.runId === undefined ? {} : { runId: launch.runId }) };
      // Rejected writes never consume a committed sequence.
      if (TERMINAL.has(launch.state)) return { accepted: false };
      if (sequence > launch.lastBatch + 1)
        throw new Error(
          `Launch ${launchId} expected batch ${launch.lastBatch + 1} but received ${sequence}.`
        );
      const runId = this.#commitBatch(launch, sequence, events);
      return { accepted: true, ...(runId === undefined ? {} : { runId }) };
    });
  }

  /** Append and transition an already-validated launch within the caller's transaction. */
  #commitBatch(
    launch: LaunchRecord,
    sequence: number,
    events: readonly PipelineTraceEvent[]
  ): string | undefined {
    this.events.append(events);
    let { runId, pipelineId, dryRun, stepCount, state } = launch;
    for (const event of events) {
      if (
        runId === undefined &&
        event.name === "pipeline.started" &&
        event.parentRunId === undefined
      ) {
        runId = event.runId;
        pipelineId = event.pipelineId;
        dryRun = event.payload.dryRun;
        stepCount = event.payload.stepCount;
        state = "running";
      } else if (
        runId !== undefined &&
        event.name === "pipeline.completed" &&
        event.runId === runId
      ) {
        state = "finished";
        if (launch.ownership === "trusted")
          this.executions.settle(launch.launchId, event.payload.status);
      }
    }
    this.storage.sql.exec(
      `UPDATE tubeless_launches
         SET run_id = ?, pipeline_id = ?, dry_run = ?, step_count = ?, state = ?, last_batch = ?
         WHERE launch_id = ?`,
      runId ?? null,
      pipelineId ?? null,
      dryRun ? 1 : 0,
      stepCount,
      state,
      sequence,
      launch.launchId
    );
    return runId;
  }

  async createAttempt(definition: HostedAttemptDefinition): Promise<void> {
    this.storage.transactionSync(() => this.#createAttempt(definition));
  }

  #createAttempt(definition: HostedAttemptDefinition): void {
    for (const id of [
      definition.launchId,
      definition.attemptId,
      definition.commandId,
      definition.pipelineId,
      definition.deploymentId,
    ])
      assertAttemptId(id);
    if (!Number.isSafeInteger(definition.createdAtMs) || definition.createdAtMs < 0)
      throw new Error("Invalid hosted attempt creation time.");
    this.#create(definition.launchId, definition.commandId, definition.createdAtMs);
    this.storage.sql.exec(
      "INSERT INTO tubeless_attempts (attempt_id, launch_id, pipeline_id, deployment_id) VALUES (?, ?, ?, ?)",
      definition.attemptId,
      definition.launchId,
      definition.pipelineId,
      definition.deploymentId
    );
  }

  async claimAttempt(
    owner: HostedAttemptOwner,
    deploymentId: string,
    nowMs: number
  ): Promise<boolean> {
    return this.storage.transactionSync(() => this.#claimAttempt(owner, deploymentId, nowMs));
  }

  #claimAttempt(owner: HostedAttemptOwner, deploymentId: string, nowMs: number): boolean {
    for (const id of [owner.launchId, owner.attemptId, owner.workerId, deploymentId])
      assertAttemptId(id);
    if (!Number.isSafeInteger(nowMs) || nowMs < 0)
      throw new Error("Invalid hosted attempt claim time.");
    const launch = this.#get(owner.launchId);
    if (!launch || TERMINAL.has(launch.state)) return false;
    const attempt = this.#getAttempt(owner);
    if (
      !attempt ||
      attempt.worker_id !== null ||
      Number(attempt.revoked) !== 0 ||
      this.#cancellationRequested(owner.attemptId) ||
      attempt.deployment_id !== deploymentId
    )
      return false;
    this.storage.sql.exec(
      "UPDATE tubeless_attempts SET worker_id = ?, claimed_at_ms = ? WHERE attempt_id = ?",
      owner.workerId,
      nowMs,
      owner.attemptId
    );
    this.storage.sql.exec(
      "UPDATE tubeless_launches SET admitted = 1 WHERE launch_id = ?",
      owner.launchId
    );
    return true;
  }

  async acceptAttemptBatch(
    owner: HostedAttemptOwner,
    body: Uint8Array
  ): Promise<AttemptBatchAcknowledgement> {
    const identity = {
      launchId: owner.launchId,
      attemptId: owner.attemptId,
      workerId: owner.workerId,
    };
    for (const id of Object.values(identity)) assertAttemptId(id);
    const batch = await decodeAttemptBatch(body);
    return this.storage.transactionSync(() => this.#acceptAttemptBatch(identity, batch));
  }

  #acceptAttemptBatch(
    owner: HostedAttemptOwner,
    batch: Awaited<ReturnType<typeof decodeAttemptBatch>>
  ): AttemptBatchAcknowledgement {
    const attempt = this.#getAttempt(owner);
    if (
      !attempt ||
      attempt.worker_id !== owner.workerId ||
      Number(attempt.revoked) !== 0 ||
      batch.attemptId !== owner.attemptId
    )
      throw new HostedAttemptConflict("ownership");
    const replay = this.#replay(owner.attemptId, batch.sequence, batch.digest);
    if (replay) return replay;
    const launch = this.#get(owner.launchId);
    if (!launch || TERMINAL.has(launch.state)) return { accepted: false };
    if (batch.sequence !== launch.lastBatch + 1)
      throw new HostedAttemptConflict("sequence", launch.lastBatch + 1);
    const runId = this.#bindEvents(owner, String(attempt.pipeline_id), launch.runId, batch.events);
    this.#commitBatch(launch, batch.sequence, batch.events);
    this.storage.sql.exec(
      "INSERT INTO tubeless_attempt_batches (attempt_id, sequence, digest, run_id) VALUES (?, ?, ?, ?)",
      owner.attemptId,
      batch.sequence,
      batch.digest,
      runId
    );
    return { accepted: true, runId };
  }

  async requestAttemptCancellation(launchId: string, attemptId: string): Promise<boolean> {
    assertAttemptId(launchId);
    assertAttemptId(attemptId);
    return this.storage.transactionSync(() => {
      const launch = this.#get(launchId);
      const attempt = this.#getAttempt({ launchId, attemptId });
      if (!launch || TERMINAL.has(launch.state) || !attempt || Number(attempt.revoked) !== 0)
        return false;
      this.storage.sql.exec(
        "INSERT OR IGNORE INTO tubeless_attempt_cancellations (attempt_id) VALUES (?)",
        attemptId
      );
      return true;
    });
  }

  async liveAttemptRunIds(deploymentId: string): Promise<readonly string[]> {
    assertAttemptId(deploymentId);
    return this.storage.sql
      .exec(
        `SELECT launch.run_id FROM tubeless_launches AS launch
       JOIN tubeless_attempts AS attempt ON attempt.launch_id = launch.launch_id
       WHERE attempt.deployment_id = ? AND launch.state = 'running' AND launch.run_id IS NOT NULL
       ORDER BY launch.created_at_ms`,
        deploymentId
      )
      .toArray()
      .map((row) => String(row.run_id));
  }

  async requestAttemptRunCancellation(runId: string, deploymentId: string): Promise<boolean> {
    assertAttemptId(runId);
    assertAttemptId(deploymentId);
    // The no-op update acknowledges repeated requests as well as the first insert.
    return (
      this.storage.sql
        .exec(
          `INSERT INTO tubeless_attempt_cancellations (attempt_id)
         SELECT attempt.attempt_id FROM tubeless_attempts AS attempt
         JOIN tubeless_launches AS launch ON launch.launch_id = attempt.launch_id
         WHERE launch.run_id = ? AND launch.state = 'running'
           AND attempt.deployment_id = ? AND attempt.revoked = 0
         ON CONFLICT (attempt_id) DO UPDATE SET attempt_id = excluded.attempt_id
         RETURNING attempt_id`,
          runId,
          deploymentId
        )
        .toArray().length > 0
    );
  }

  #cancellationRequested(attemptId: string): boolean {
    return (
      this.storage.sql
        .exec("SELECT 1 FROM tubeless_attempt_cancellations WHERE attempt_id = ?", attemptId)
        .toArray().length > 0
    );
  }

  async revokeAttempt(launchId: string, attemptId: string): Promise<void> {
    assertAttemptId(launchId);
    assertAttemptId(attemptId);
    this.storage.transactionSync(() =>
      this.storage.sql.exec(
        "UPDATE tubeless_attempts SET revoked = 1 WHERE launch_id = ? AND attempt_id = ?",
        launchId,
        attemptId
      )
    );
  }

  async provisionCollectorAttempt(
    definition: HostedAttemptDefinition,
    credential: CollectorCredential
  ): Promise<void> {
    if (
      !isCollectorCredentialId(credential.credentialId) ||
      !isCollectorVerifier(credential.verifier) ||
      !Number.isSafeInteger(credential.notBeforeMs) ||
      !Number.isSafeInteger(credential.expiresAtMs) ||
      credential.notBeforeMs < 0 ||
      credential.expiresAtMs <= credential.notBeforeMs
    )
      throw new CollectorInputError();
    this.storage.transactionSync(() => {
      this.#createAttempt(definition);
      this.storage.sql.exec(
        "INSERT INTO tubeless_collector_credentials (attempt_id, credential_id, verifier, not_before_ms, expires_at_ms) VALUES (?, ?, ?, ?, ?)",
        definition.attemptId,
        credential.credentialId,
        credential.verifier,
        credential.notBeforeMs,
        credential.expiresAtMs
      );
    });
  }

  async getCollectorCredential(
    launchId: string,
    credentialId: string
  ): Promise<StoredCollectorCredential | undefined> {
    const row = this.storage.sql
      .exec(
        `SELECT credential.*, attempt.launch_id FROM tubeless_collector_credentials AS credential
       JOIN tubeless_attempts AS attempt ON attempt.attempt_id = credential.attempt_id
       WHERE attempt.launch_id = ? AND credential.credential_id = ? AND attempt.revoked = 0`,
        launchId,
        credentialId
      )
      .toArray()[0];
    if (!row) return undefined;
    return {
      launchId: String(row.launch_id),
      attemptId: String(row.attempt_id),
      credentialId: String(row.credential_id),
      verifier: String(row.verifier),
      notBeforeMs: Number(row.not_before_ms),
      expiresAtMs: Number(row.expires_at_ms),
    };
  }

  #requireCollectorAuthority(authority: CollectorAuthorization): void {
    const now = this.now();
    const row = this.storage.sql
      .exec(
        `SELECT 1 FROM tubeless_collector_credentials AS credential
       JOIN tubeless_attempts AS attempt ON attempt.attempt_id = credential.attempt_id
       WHERE attempt.launch_id = ? AND attempt.attempt_id = ? AND credential.credential_id = ?
       AND credential.verifier = ? AND attempt.revoked = 0 AND credential.not_before_ms <= ? AND credential.expires_at_ms > ?`,
        authority.launchId,
        authority.attemptId,
        authority.credentialId,
        authority.verifier,
        now,
        now
      )
      .toArray()[0];
    if (!row) throw new CollectorAuthorityError();
  }

  async claimCollectorAttempt(
    authority: CollectorAuthorization,
    workerId: string,
    deploymentId: string
  ): Promise<boolean> {
    return this.storage.transactionSync(() => {
      this.#requireCollectorAuthority(authority);
      return this.#claimAttempt(
        { launchId: authority.launchId, attemptId: authority.attemptId, workerId },
        deploymentId,
        this.now()
      );
    });
  }

  async acceptCollectorBatch(
    authority: CollectorAuthorization,
    workerId: string,
    body: Uint8Array
  ): Promise<AttemptBatchAcknowledgement> {
    const snapshot = { ...authority };
    assertAttemptId(workerId);
    const batch = await decodeAttemptBatch(body);
    return this.storage.transactionSync(() => {
      this.#requireCollectorAuthority(snapshot);
      return this.#acceptAttemptBatch(
        { launchId: snapshot.launchId, attemptId: snapshot.attemptId, workerId },
        batch
      );
    });
  }

  async collectorCancellationRequested(
    authority: CollectorAuthorization,
    workerId: string
  ): Promise<boolean> {
    assertAttemptId(workerId);
    return this.storage.transactionSync(() => {
      this.#requireCollectorAuthority(authority);
      const attempt = this.#getAttempt(authority);
      if (!attempt || attempt.worker_id !== workerId) throw new HostedAttemptConflict("ownership");
      return this.#cancellationRequested(authority.attemptId);
    });
  }

  async reportCollectorFailure(
    authority: CollectorAuthorization,
    workerId: string,
    body: Uint8Array
  ): Promise<boolean> {
    const snapshot = { ...authority };
    assertAttemptId(workerId);
    if (body.byteLength > COLLECTOR_FAILURE_BYTES) throw new CollectorInputError(413);
    const bytes = new Uint8Array(body);
    const failure = decodeCollectorJson(bytes, failureSchema);
    if (new TextEncoder().encode(failure.message).byteLength > COLLECTOR_MESSAGE_BYTES)
      throw new CollectorInputError(413);
    const digest = await digestCollectorBody(bytes);
    return this.storage.transactionSync(() => {
      this.#requireCollectorAuthority(snapshot);
      const attempt = this.#getAttempt(snapshot);
      if (failure.attemptId !== snapshot.attemptId || !attempt || attempt.worker_id !== workerId)
        throw new HostedAttemptConflict("ownership");
      const receipt = this.storage.sql
        .exec(
          "SELECT digest, recorded FROM tubeless_attempt_failures WHERE attempt_id = ? AND failure_id = ?",
          snapshot.attemptId,
          failure.failureId
        )
        .toArray()[0];
      if (receipt) {
        if (receipt.digest !== digest) throw new HostedAttemptConflict("replay");
        return Number(receipt.recorded) === 1;
      }
      const launch = this.#get(snapshot.launchId);
      const recorded = launch !== undefined && !TERMINAL.has(launch.state);
      if (recorded) this.#fail(launch, failure.message, this.now());
      this.storage.sql.exec(
        "INSERT INTO tubeless_attempt_failures (attempt_id, failure_id, digest, recorded) VALUES (?, ?, ?, ?)",
        snapshot.attemptId,
        failure.failureId,
        digest,
        recorded ? 1 : 0
      );
      return recorded;
    });
  }

  #getAttempt(owner: Pick<HostedAttemptOwner, "launchId" | "attemptId">) {
    return this.storage.sql
      .exec(
        "SELECT * FROM tubeless_attempts WHERE launch_id = ? AND attempt_id = ?",
        owner.launchId,
        owner.attemptId
      )
      .toArray()[0];
  }

  #replay(
    attemptId: string,
    sequence: number,
    digest: string
  ): AttemptBatchAcknowledgement | undefined {
    const row = this.storage.sql
      .exec(
        "SELECT digest, run_id FROM tubeless_attempt_batches WHERE attempt_id = ? AND sequence = ?",
        attemptId,
        sequence
      )
      .toArray()[0];
    if (!row) return undefined;
    if (row.digest !== digest) throw new HostedAttemptConflict("replay");
    return { accepted: true, runId: String(row.run_id) };
  }

  #bindEvents(
    owner: HostedAttemptOwner,
    pipelineId: string,
    rootRunId: string | undefined,
    events: readonly PipelineTraceEvent[]
  ): string {
    let root = rootRunId;
    for (const event of events) {
      if (event.name === "pipeline.started") {
        // A run id cannot be stolen from either another attempt or trusted history.
        const recorded = this.storage.sql
          .exec("SELECT 1 FROM pipeline_run_events WHERE run_id = ? LIMIT 1", event.runId)
          .toArray()[0];
        const bound = this.#runBinding(event.runId);
        if (recorded || bound) throw new HostedAttemptConflict("events");
        if (event.parentRunId === undefined) {
          if (root !== undefined || event.pipelineId !== pipelineId)
            throw new HostedAttemptConflict("events");
          root = event.runId;
        } else {
          const parent = this.#runBinding(event.parentRunId);
          if (!parent || parent.attempt_id !== owner.attemptId)
            throw new HostedAttemptConflict("events");
        }
        this.storage.sql.exec(
          "INSERT INTO tubeless_attempt_runs (run_id, attempt_id, pipeline_id, parent_run_id) VALUES (?, ?, ?, ?)",
          event.runId,
          owner.attemptId,
          event.pipelineId,
          event.parentRunId ?? null
        );
      } else {
        const run = this.#runBinding(event.runId);
        if (
          !run ||
          run.attempt_id !== owner.attemptId ||
          run.pipeline_id !== event.pipelineId ||
          run.parent_run_id !== (event.parentRunId ?? null)
        )
          throw new HostedAttemptConflict("events");
      }
    }
    // Every accepted owned batch belongs to a bound root, including the first batch.
    if (root === undefined) throw new HostedAttemptConflict("events");
    return root;
  }

  #runBinding(runId: string) {
    return this.storage.sql
      .exec("SELECT * FROM tubeless_attempt_runs WHERE run_id = ?", runId)
      .toArray()[0];
  }

  async failUnadmitted(launchId: string, message: string, nowMs: number): Promise<void> {
    this.storage.transactionSync(() => {
      const launch = this.#get(launchId);
      if (launch && !launch.admitted) this.#fail(launch, message, nowMs);
    });
  }

  async fail(
    launchId: string,
    message: string,
    nowMs: number,
    reason?: HostedFailureReason
  ): Promise<void> {
    this.storage.transactionSync(() => {
      const launch = this.#get(launchId);
      if (launch) this.#fail(launch, message, nowMs, reason);
    });
  }

  #fail(launch: LaunchRecord, message: string, nowMs: number, reason?: HostedFailureReason): void {
    if (TERMINAL.has(launch.state)) return;
    if (launch.runId)
      this.events.append(this.#openSubtreeCompletions(launch.runId, message, nowMs));
    this.storage.sql.exec(
      "UPDATE tubeless_launches SET state = 'failed' WHERE launch_id = ?",
      launch.launchId
    );
    if (launch.ownership === "trusted")
      this.executions.settle(
        launch.launchId,
        launch.admitted ? "outcome_unknown" : "failed",
        reason === "host_terminated" && !launch.admitted
          ? "start_unconfirmed"
          : (reason ?? "host_failure")
      );
  }

  /** Close the bound run and every nested run it left open, children before parents. */
  #openSubtreeCompletions(rootRunId: string, message: string, nowMs: number) {
    const { sql, params } = openSubtreeStartsQuery(rootRunId);
    // SAFETY: SELECT * over the owned pipeline_run_events table returns RunEventRecord rows.
    const rows = this.storage.sql.exec(sql, ...params).toArray() as unknown as RunEventRecord[];
    const closed = new Set<string>();
    const completions: PipelineTraceEvent[] = [];
    for (const row of rows) {
      const started = storedRunEvent(row);
      if (started.name !== "pipeline.started" || closed.has(started.runId)) continue;
      closed.add(started.runId);
      completions.push(hostTerminatedEvent(started, message, nowMs));
    }
    return completions;
  }

  async liveRunIds(): Promise<readonly string[]> {
    return this.storage.sql
      .exec(
        `${TRUSTED_LAUNCHES} SELECT run_id FROM trusted_launches WHERE state = 'running' AND run_id IS NOT NULL ORDER BY created_at_ms`
      )
      .toArray()
      .map((row) => String(row.run_id));
  }

  async launchIdForRun(runId: string): Promise<string | undefined> {
    const row = this.storage.sql
      .exec(
        `${TRUSTED_LAUNCHES} SELECT launch_id FROM trusted_launches WHERE run_id = ? AND state = 'running'`,
        runId
      )
      .toArray()[0];
    return row ? String(row.launch_id) : undefined;
  }

  listEvents(query?: PipelineRunEventQuery) {
    return this.events.listEvents(query);
  }

  close() {
    return this.events.close();
  }
}
