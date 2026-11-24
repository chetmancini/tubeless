import type { SqliteStorage } from "../hosting/sqlite-storage.js";

/** Structural subset of DurableObjectStorage used by Tubeless. */
export interface DurableStorageLike extends SqliteStorage {
  transaction<T>(fn: () => Promise<T>): Promise<T>;
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
  getAlarm(): Promise<number | null>;
  setAlarm(scheduledTimeMs: number): Promise<void>;
  deleteAlarm(): Promise<void>;
}
