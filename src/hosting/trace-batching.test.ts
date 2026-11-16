import { describe, expect, it, vi } from "vitest";
import type { PipelineTraceEvent } from "../tracing/tracing.js";
import { BatchingTraceExporter } from "./trace-batching.js";

const startEvent: PipelineTraceEvent = {
  version: 3,
  name: "pipeline.started",
  runId: "r",
  pipelineId: "p",
  timestampMs: 1,
  payload: { dryRun: false, planOk: true, stepCount: 0, targetIds: [] },
};
const logEvent: PipelineTraceEvent = {
  version: 3,
  name: "pipeline.log",
  runId: "r",
  pipelineId: "p",
  timestampMs: 1,
  payload: { level: "log", message: "x" },
};

describe("batching exporter", () => {
  it("flushes the top-level start immediately and numbers later batches", async () => {
    const sent: number[] = [];
    const exporter = new BatchingTraceExporter(async (sequence) => void sent.push(sequence), {
      maxEvents: 50,
      maxDelayMs: 10_000,
      onFailure: () => {},
    });
    await exporter.export(startEvent);
    expect(sent).toEqual([0]);
    await exporter.export(logEvent);
    await exporter.flush();
    expect(sent).toEqual([0, 1]);
  });

  it("flushes when maxEvents is reached", async () => {
    const sent: number[] = [];
    const exporter = new BatchingTraceExporter(async (sequence) => void sent.push(sequence), {
      maxEvents: 2,
      maxDelayMs: 10_000,
      onFailure: () => {},
    });
    await exporter.export(logEvent);
    expect(sent).toEqual([]);
    await exporter.export(logEvent);
    expect(sent).toEqual([0]);
  });

  it("flushes after maxDelayMs", async () => {
    vi.useFakeTimers();
    try {
      const sent: number[] = [];
      const exporter = new BatchingTraceExporter(async (sequence) => void sent.push(sequence), {
        maxEvents: 50,
        maxDelayMs: 100,
        onFailure: () => {},
      });
      await exporter.export(logEvent);
      await vi.advanceTimersByTimeAsync(99);
      expect(sent).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(sent).toEqual([0]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports one failed delivery and never sends later sequences", async () => {
    const onFailure = vi.fn();
    const send = vi.fn(async (_sequence: number) => {
      throw new Error("down");
    });
    const exporter = new BatchingTraceExporter(send, {
      maxEvents: 1,
      maxDelayMs: 0,
      onFailure,
    });
    await expect(exporter.export(logEvent)).rejects.toThrow("down");
    await expect(exporter.export(logEvent)).rejects.toThrow("down");
    await expect(exporter.flush()).rejects.toThrow("down");
    expect(send.mock.calls.map(([sequence]) => sequence)).toEqual([0]);
    expect(onFailure).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message: "down" }));
  });
});
