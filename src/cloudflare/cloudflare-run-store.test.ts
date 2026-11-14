import { describe, expect, it } from "vitest";
import { createFakeDurableStorage } from "./cloudflare-storage.test-support.js";
import { openDurableRunStore } from "./cloudflare-run-store.js";
import type { PipelineTraceEvent } from "../tracing/tracing.js";

const base = { version: 3 as const, pipelineId: "demo", timestampMs: 1 };
const started = (runId: string, parentRunId?: string, stepCount = 2): PipelineTraceEvent => ({
  ...base,
  runId,
  ...(parentRunId ? { parentRunId } : {}),
  name: "pipeline.started",
  payload: { dryRun: false, planOk: true, stepCount, targetIds: [] },
});
function setup() {
  const storage = createFakeDurableStorage();
  return { storage, store: openDurableRunStore(storage) };
}

describe("Durable Object run store", () => {
  it("creates the schema once and stays append-only", async () => {
    const { storage, store } = setup();
    openDurableRunStore(storage);
    storage.transactionSync(() => store.append([started("r1")]));
    expect((await store.listEvents()).map((event) => event.id)).toEqual([1]);
    expect(() => storage.sql.exec("DELETE FROM pipeline_run_events")).toThrow(/append-only/);
  });

  it("rejects an unknown schema version", () => {
    const { storage } = setup();
    storage.sql.exec("UPDATE tubeless_meta SET value = '99' WHERE key = 'run_event_store_version'");
    expect(() => openDurableRunStore(storage)).toThrow(/schema version 99/);
  });
});
