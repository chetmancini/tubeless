export interface SqliteStorage {
  readonly sql: {
    exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] };
  };
  transactionSync<T>(fn: () => T): T;
}
