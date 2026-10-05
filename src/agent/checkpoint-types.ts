/** Exclusive ownership of one execution's acknowledged checkpoint bytes. */
export interface AgentCheckpointLease {
  read(): Promise<string | undefined>;
  /** Atomically replace the checkpoint; resolve only once it is durably stored. */
  write(checkpoint: string): Promise<void>;
  /** Release ownership without deleting the execution. */
  close(): Promise<void>;
}

/** Pluggable checkpoint persistence. A key may have only one live lease. */
export interface AgentCheckpointStore {
  acquire(key: string): Promise<AgentCheckpointLease>;
}

/** Lossless serialization for persisted state, validated arguments and outcomes. */
export interface AgentCheckpointCodec {
  encode(value: unknown): string;
  decode(checkpoint: string): unknown;
}

/** Resume the same execution key on subsequent invocations with the same definition and inputs. */
export interface AgentDurability<Options extends object> {
  readonly store: AgentCheckpointStore;
  readonly key: string | ((options: Options) => string);
  /** Defaults to finite plain data, including undefined and sparse arrays. */
  readonly codec?: AgentCheckpointCodec;
}

/** Stable durable identities for business idempotency and cross-attempt correlation. */
export interface AgentExecutionIdentity {
  readonly id: string;
  readonly agent: string;
  readonly turn: number;
  readonly call?: string;
}
