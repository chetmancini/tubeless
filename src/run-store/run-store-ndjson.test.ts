import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openNdjsonPipelineRunStore } from "./run-store-ndjson.js";
import { createSteps, definePipeline } from "tubeless";
import { createJsonTraceExporter } from "../tracing/tracing-json.js";
import { openSqlitePipelineRunStore } from "./run-store-sqlite.js";
import { projectPipelineRunStore } from "./run-store.js";
import type { PipelineTraceEvent } from "../tracing/tracing.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true }))
  );
});

async function tempFile(contents: string | Buffer): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "tubeless-ndjson-store-"));
  directories.push(directory);
  const filename = path.join(directory, "run.ndjson");
  await writeFile(filename, contents);
  return filename;
}

function event(runId: string, pipelineId = "import"): PipelineTraceEvent {
  return {
    attributes: { dry_run: false },
    name: "pipeline.started",
    pipelineId,
    runId,
    timestampMs: 1_700_000_000_000,
    version: 1,
  };
}

describe("openNdjsonPipelineRunStore", () => {
  it("assigns zero-based ids and supports store-compatible filters and pagination", async () => {
    const filename = await tempFile(
      `${JSON.stringify(event("run-1"))}\n\n${JSON.stringify(event("run-2", "publish"))}\n`
    );
    const store = await openNdjsonPipelineRunStore(filename);

    expect("export" in store).toBe(false);

    await expect(store.listEvents()).resolves.toMatchObject([
      { id: 0, pipelineId: "import", runId: "run-1" },
      { id: 1, pipelineId: "publish", runId: "run-2" },
    ]);
    await expect(store.listEvents({ afterId: 0 })).resolves.toMatchObject([
      { id: 1, runId: "run-2" },
    ]);
    await expect(store.listEvents({ pipelineId: "publish", runId: "run-2" })).resolves.toHaveLength(
      1
    );

    await store.close();
    await expect(store.listEvents()).rejects.toThrow("closed NDJSON pipeline run store");
  });

  it("rejects malformed events without echoing their contents", async () => {
    const secret = "do-not-repeat-this-secret";
    const filename = await tempFile(`{"token":"${secret}"}\n`);
    const invalidJson = await tempFile(`{"token":"${secret}"\n`);

    const opening = openNdjsonPipelineRunStore(filename);

    await expect(opening).rejects.toThrow(`${filename} line 1 is invalid`);
    await expect(opening).rejects.not.toThrow(secret);
    const invalidOpening = openNdjsonPipelineRunStore(invalidJson);
    await expect(invalidOpening).rejects.toThrow(`${invalidJson} line 1 is not valid JSON`);
    await expect(invalidOpening).rejects.not.toThrow(secret);
  });

  it("rejects completion events without a supported terminal status", async () => {
    const completion = {
      ...event("run-1"),
      attributes: {},
      name: "pipeline.completed",
    };
    const missingStatus = await tempFile(`${JSON.stringify(completion)}\n`);
    const unsupportedStatus = await tempFile(
      `${JSON.stringify({ ...completion, attributes: { status: "running" } })}\n`
    );

    await expect(openNdjsonPipelineRunStore(missingStatus)).rejects.toThrow(
      "attributes.status must be cancelled, completed, or failed for pipeline.completed"
    );
    await expect(openNdjsonPipelineRunStore(unsupportedStatus)).rejects.toThrow(
      "attributes.status must be cancelled, completed, or failed for pipeline.completed"
    );
  });

  it("enforces artifact, event, and event-count limits", async () => {
    const line = JSON.stringify(event("run-1"));
    const filename = await tempFile(`${line}\n${line}\n`);

    await expect(openNdjsonPipelineRunStore(filename, { maxBytes: 10 })).rejects.toThrow(
      "10-byte NDJSON trace limit"
    );
    await expect(
      openNdjsonPipelineRunStore(filename, { maxBytes: 10_000, maxEventBytes: 10 })
    ).rejects.toThrow("10-byte event limit");
    await expect(
      openNdjsonPipelineRunStore(filename, { maxBytes: 10_000, maxEvents: 1 })
    ).rejects.toThrow("1-event NDJSON trace limit");
  });

  it("rejects invalid UTF-8", async () => {
    const filename = await tempFile(Buffer.from([0xc3, 0x28, 0x0a]));

    await expect(openNdjsonPipelineRunStore(filename)).rejects.toThrow("line 1 is not valid UTF-8");
  });
});

describe("recorded fan-out diagnostics", () => {
  it("round-trips real failures through JSON, SQLite, and history projection", async () => {
    const childStep = createSteps();
    const work = childStep("work", {
      run: () => {
        throw Object.assign(new Error("failed"), { code: "RETRY" });
      },
    });
    const child = definePipeline({ id: "child", steps: [work], finalize: () => true });
    const step = createSteps();
    const fan = step.forEachPipeline("fan", {
      pipeline: child,
      items: () => Array.from({ length: 40 }, (_, index) => index),
      key: (index) => `${index}-${"k".repeat(1024)}`,
      mapOptions: () => ({}),
      concurrency: 3,
    });
    const pipeline = definePipeline({ id: "parent", steps: [fan], finalize: () => true });
    const lines: string[] = [];
    const run = await pipeline.run(
      {},
      {},
      { tracing: { exporter: createJsonTraceExporter({ write: (line) => lines.push(line) }) } }
    );
    const expected = run.errors[0]!.fanOut;
    expect(expected).toMatchObject({ failureCount: 40, omittedFailureCount: 8 });
    const filename = await tempFile(`${lines.join("\n")}\n`);
    const ndjson = await openNdjsonPipelineRunStore(filename);
    const sqlite = await openSqlitePipelineRunStore(
      path.join(path.dirname(filename), "runs.sqlite")
    );
    try {
      const events = await ndjson.listEvents();
      for (const recorded of events) await sqlite.export(recorded);
      await sqlite.flush?.();
      for (const reader of [ndjson, sqlite]) {
        const restored = await reader.listEvents();
        expect(
          restored.find((entry) => entry.runId === run.runId && entry.name === "step.failed")?.error
            ?.fanOut
        ).toEqual(expected);
        expect(
          projectPipelineRunStore(restored).runs.find((entry) => entry.runId === run.runId)?.error
            ?.fanOut
        ).toEqual(expected);
      }
    } finally {
      await ndjson.close();
      await sqlite.close();
    }
  });

  const failure = {
    index: 0,
    key: "",
    keyTruncated: false,
    cancelled: true,
    error: { message: "" },
  };
  const diagnostics = {
    failures: [failure],
    failureCount: 1,
    omittedFailureCount: 0,
    schedulerError: { message: "stop", name: "AbortError" },
  };
  const error = {
    code: "TUBELESS_CHILD_FAILED",
    kind: "child",
    phase: "execution",
    message: "failed",
  };

  it("preserves cancellation, scheduler causes, and empty snapshot strings", async () => {
    const filename = await tempFile(
      JSON.stringify({ ...event("run-1"), error: { ...error, fanOut: diagnostics } })
    );
    const store = await openNdjsonPipelineRunStore(filename);
    try {
      expect((await store.listEvents())[0]?.error?.fanOut).toEqual(diagnostics);
    } finally {
      await store.close();
    }
  });

  it.each([
    null,
    { ...diagnostics, failures: {} },
    { ...diagnostics, failures: Array(33).fill(failure), failureCount: 33 },
    { ...diagnostics, failureCount: -1 },
    { ...diagnostics, omittedFailureCount: 0.5 },
    { ...diagnostics, failureCount: 2 },
    { ...diagnostics, failures: [{ ...failure, index: -1 }] },
    { ...diagnostics, failures: [failure, failure], failureCount: 2 },
    { ...diagnostics, failures: [{ ...failure, key: "k".repeat(1025) }] },
    { ...diagnostics, failures: [{ ...failure, cancelled: "true" }] },
    { ...diagnostics, failures: [{ ...failure, error: { message: "m".repeat(1025) } }] },
    { ...diagnostics, schedulerError: { message: "stop", cause: null } },
  ])("rejects malformed fan-out diagnostics %#", async (fanOut) => {
    const filename = await tempFile(
      JSON.stringify({ ...event("run-1"), error: { ...error, fanOut } })
    );
    await expect(openNdjsonPipelineRunStore(filename)).rejects.toThrow("line 1 is invalid");
  });
});
