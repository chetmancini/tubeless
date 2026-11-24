import { SqliteHostedLaunchStore } from "../launch-store-sqlite.js";
import { createSqliteLaunchStoreFixture } from "../launch-store-sqlite.test-support.js";
import { provisionCollectorAttempt } from "./credentials.js";
import { createHostedCollector } from "./http.js";
import { createHostedCollectorClient } from "./client.js";
import type { PipelineTraceEvent } from "../../tracing/tracing.js";

export const definition = {
  launchId: "launch",
  attemptId: "attempt",
  commandId: "command",
  pipelineId: "pipeline",
  deploymentId: "release-1",
  createdAtMs: 100,
};
export const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
export const started = (runId = "root", parentRunId?: string): PipelineTraceEvent => ({
  version: 3,
  name: "pipeline.started",
  pipelineId: "pipeline",
  runId,
  timestampMs: 101,
  ...(parentRunId === undefined ? {} : { parentRunId }),
  payload: { dryRun: false, planOk: true, stepCount: 0, targetIds: [] },
});
export const log = (message = "hello"): Extract<PipelineTraceEvent, { name: "pipeline.log" }> => ({
  version: 3,
  name: "pipeline.log",
  pipelineId: "pipeline",
  runId: "root",
  timestampMs: 102,
  payload: { level: "log", message },
});
export const completed = (): PipelineTraceEvent => ({
  version: 3,
  name: "pipeline.completed",
  pipelineId: "pipeline",
  runId: "root",
  timestampMs: 103,
  payload: { dryRun: false, errorCount: 0, finalized: true, status: "completed", stepCount: 0 },
});
export const batch = (sequence: number, events: readonly PipelineTraceEvent[]) =>
  encode({ attemptId: definition.attemptId, sequence, events });
export const failure = (message = "Worker exited", failureId = "failure") =>
  encode({ attemptId: definition.attemptId, failureId, message });
export async function collectorFixture(filename?: string) {
  const fixture = createSqliteLaunchStoreFixture(filename);
  const clock = { now: 100 };
  const store = new SqliteHostedLaunchStore(fixture.storage, fixture.events, () => clock.now);
  const token = await provisionCollectorAttempt(store, definition, 1_000);
  const collector = createHostedCollector({ store, now: () => clock.now });
  const send = (
    operation: string,
    body: BodyInit | null,
    headers: HeadersInit = {},
    launchId = "launch"
  ) => {
    const merged = new Headers({
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-tubeless-worker-id": "worker",
    });
    new Headers(headers).forEach((value, key) => merged.set(key, value));
    return collector.fetch(
      new Request(`https://collector.test/v1/launches/${launchId}/${operation}`, {
        method: "POST",
        body,
        headers: merged,
        // Node requires duplex for streamed request bodies; other Fetch runtimes ignore it.
        ...{ duplex: "half" },
      })
    );
  };
  const client = (
    transport: typeof fetch = (input, init) => collector.fetch(new Request(input, init))
  ) =>
    createHostedCollectorClient({
      baseUrl: "https://collector.test",
      ...definition,
      token,
      fetch: transport,
    });
  const authority = (await store.getCollectorCredential("launch", token.slice(0, 32)))!;
  return { ...fixture, clock, store, token, authority, collector, send, client };
}
