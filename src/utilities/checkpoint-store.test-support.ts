import type { CheckpointStore } from "./checkpoint-store.js";

/** In-memory `context.checkpoint` stand-in for tests that never assert on stored keys. */
export function stubCheckpointStore(overrides: Partial<CheckpointStore> = {}): CheckpointStore {
  return {
    has: () => false,
    record: () => {},
    entries: () => new Map(),
    flush: () => {},
    clear: () => {},
    ...overrides,
  };
}
