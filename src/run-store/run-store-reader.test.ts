import { describe, expect, it, vi } from "vitest";
import type { PipelineRunEventQuery, StoredPipelineEvent } from "./run-store.js";
import { readPipelineEventPages } from "./run-store-reader.js";

function event(id: number, runId = "run", pipelineId = "pipeline"): StoredPipelineEvent {
  return {
    id,
    name: "pipeline.started",
    payload: { dryRun: false, planOk: true, stepCount: 0, targetIds: [] },
    pipelineId,
    runId,
    timestampMs: id,
    version: 2,
  };
}

async function collect(pages: AsyncIterable<readonly StoredPipelineEvent[]>) {
  const events: StoredPipelineEvent[] = [];
  for await (const page of pages) events.push(...page);
  return events;
}

describe("readPipelineEventPages", () => {
  it("reads past short pages and preserves zero as the first cursor", async () => {
    const events = [event(0), event(1), event(2)];
    const queries: PipelineRunEventQuery[] = [];
    const reader = {
      async listEvents(query: PipelineRunEventQuery = {}) {
        queries.push(query);
        return events
          .filter(({ id }) => query.afterId === undefined || id > query.afterId)
          .slice(0, 1);
      },
    };
    expect(await collect(readPipelineEventPages(reader, { runId: "run", limit: 100 }))).toEqual(
      events
    );
    expect(queries.map(({ afterId }) => afterId)).toEqual([undefined, 0, 1, 2]);
    expect(queries.every(({ runId, limit }) => runId === "run" && limit === 100)).toBe(true);
  });

  it("orders and deduplicates overlapping pages and stops a nonadvancing reader", async () => {
    const pages = [[event(2), event(0), event(1), event(1)], [event(3), event(2)], [event(3)]];
    const listEvents = vi.fn(async () => pages.shift() ?? []);
    const result = await collect(readPipelineEventPages({ listEvents }));
    expect(result.map(({ id }) => id)).toEqual([0, 1, 2, 3]);
    expect(listEvents).toHaveBeenCalledTimes(3);
  });

  it("advances through nonmatching pages while enforcing both query filters", async () => {
    const listEvents = vi.fn(async (query: PipelineRunEventQuery = {}) => {
      return [event(1, "other"), event(2, "run", "other"), event(3)]
        .filter(({ id }) => query.afterId === undefined || id > query.afterId)
        .slice(0, 1);
    });
    const result = await collect(
      readPipelineEventPages(
        { listEvents },
        {
          afterId: 0,
          runId: "run",
          pipelineId: "pipeline",
        }
      )
    );
    expect(result.map(({ id }) => id)).toEqual([3]);
    expect(listEvents.mock.calls.map(([query]) => query?.afterId)).toEqual([0, 1, 2, 3]);
  });

  it("waits for the consumer and leaves the reader open when iteration stops early", async () => {
    const reader = { listEvents: vi.fn(async () => [event(0)]), close: vi.fn() };
    const pages = readPipelineEventPages(reader);
    expect(reader.listEvents).not.toHaveBeenCalled();
    await expect(pages.next()).resolves.toMatchObject({ done: false });
    await Promise.resolve();
    expect(reader.listEvents).toHaveBeenCalledTimes(1);
    await pages.return(undefined);
    expect(reader.listEvents).toHaveBeenCalledTimes(1);
    expect(reader.close).not.toHaveBeenCalled();
  });

  it("propagates read failures after yielding all preceding pages", async () => {
    const failure = new Error("Reader unavailable");
    const listEvents = vi
      .fn()
      .mockResolvedValueOnce([event(0)])
      .mockRejectedValueOnce(failure);
    const pages = readPipelineEventPages({ listEvents });
    await expect(pages.next()).resolves.toMatchObject({ done: false, value: [event(0)] });
    await expect(pages.next()).rejects.toBe(failure);
  });
});
