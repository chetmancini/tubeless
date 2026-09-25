import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openNdjsonPipelineRunStore } from "./run-store-ndjson.js";
import { createSteps, definePipeline } from "tubeless";
import { createPipelineTestRuntime, overrideStep } from "tubeless/testing";
import { openSqlitePipelineRunStore } from "./run-store-sqlite.js";
import { projectPipelineRunStore } from "./run-store.js";
import type { PipelineTraceEvent, PipelineTraceExporter } from "../tracing/tracing.js";

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

function event(runId: string, pipelineId = "import"): Record<string, unknown> {
  return {
    name: "pipeline.started",
    payload: { dryRun: false, planOk: true, stepCount: 0, targetIds: [] },
    pipelineId,
    runId,
    timestampMs: 1_700_000_000_000,
    version: 2,
  };
}

function captureJson(lines: string[]): PipelineTraceExporter {
  return { export: (value) => void lines.push(JSON.stringify(value)) };
}

describe("openNdjsonPipelineRunStore", () => {
  it("retains definition versions after reopening SQLite and NDJSON artifacts", async () => {
    const lines: string[] = [];
    const definitions = [];
    for (const implementationVersion of ["one", "two"]) {
      const pipeline = definePipeline({
        id: "versions",
        implementationVersion,
        steps: [],
        finalize: () => true,
      });
      definitions.push(pipeline.definition);
      await pipeline.run({}, {}, { tracing: { exporter: captureJson(lines) } });
    }
    const filename = await tempFile(lines.join("\n"));
    const ndjson = await openNdjsonPipelineRunStore(filename);
    const sqlitePath = path.join(path.dirname(filename), "versions.sqlite");
    const writer = await openSqlitePipelineRunStore(sqlitePath);
    for (const recorded of await ndjson.listEvents()) await writer.export(recorded);
    await writer.close();
    const reopened = await openSqlitePipelineRunStore(sqlitePath);
    try {
      for (const reader of [ndjson, reopened]) {
        const snapshot = projectPipelineRunStore(await reader.listEvents());
        expect(snapshot.definitions).toHaveLength(2);
        for (const definition of definitions) {
          expect(
            snapshot.definitions.find(
              (item) => item.identity?.definitionId === definition.identity.definitionId
            )?.snapshot
          ).toEqual(definition);
          expect(
            snapshot.runs.filter(
              (run) => run.definitionIdentity?.definitionId === definition.identity.definitionId
            )
          ).toHaveLength(1);
        }
      }
    } finally {
      await ndjson.close();
      await reopened.close();
    }
  });

  it.each(["a", "界", '\u0000"\\'])(
    "reopens large detail payloads containing %j with default byte limits",
    async (text) => {
      const { step } = createSteps();
      const details = Array.from({ length: 128 }, (_, index) => ({
        id: `${index}${text.repeat(2048)}`.slice(0, 2048),
        label: text.repeat(2048).slice(0, 2048),
        name: text.repeat(4096).slice(0, 4096),
        status: "running" as const,
      }));
      const pipeline = definePipeline({
        id: "large-details",
        steps: [
          step("work", {
            run: (_, context) => {
              context.reportProgress({ completed: 1, total: 2, details });
            },
          }),
        ],
        finalize: () => true,
      });
      const lines: string[] = [];
      await pipeline.run({}, undefined, {
        tracing: { exporter: captureJson(lines) },
      });
      expect(Math.max(...lines.map((line) => Buffer.byteLength(line, "utf8")))).toBeLessThan(
        1024 * 1024
      );
      const store = await openNdjsonPipelineRunStore(await tempFile(`${lines.join("\n")}\n`));
      try {
        const events = await store.listEvents();
        const recorded = events.find(
          (event) => event.name === "step.running" && event.payload.progress?.detailCount === 128
        );
        if (recorded?.name !== "step.running") throw new Error("missing progress trace");
        expect(
          Buffer.byteLength(JSON.stringify(recorded?.payload.progress?.details), "utf8")
        ).toBeLessThanOrEqual(256 * 1024);
        const progress = projectPipelineRunStore(events).runs[0]?.steps[0]?.progress;
        expect(progress?.detailCount).toBe(128);
        expect(progress?.details?.length).toBeGreaterThan(0);
        expect(progress?.details?.length).toBeLessThan(128);
        expect(progress?.details?.[0]).toEqual(details[0]);
      } finally {
        await store.close();
      }
    }
  );

  it("reads durable version 2 recordings with store-compatible filters", async () => {
    const correlated = { ...event("run-1"), correlationId: "job-1" };
    const filename = await tempFile(
      `${JSON.stringify(correlated)}\n\n${JSON.stringify(event("run-2", "publish"))}\n`
    );
    const store = await openNdjsonPipelineRunStore(filename);

    expect("export" in store).toBe(false);

    await expect(store.listEvents()).resolves.toMatchObject([
      {
        correlationId: "job-1",
        id: 0,
        payload: { dryRun: false, targetIds: [] },
        pipelineId: "import",
        runId: "run-1",
        version: 2,
      },
      { id: 1, pipelineId: "publish", runId: "run-2", version: 2 },
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
      name: "pipeline.completed",
      payload: { dryRun: false, errorCount: 0, finalized: false, stepCount: 0 },
    };
    const missingStatus = await tempFile(`${JSON.stringify(completion)}\n`);
    const unsupportedStatus = await tempFile(
      `${JSON.stringify({ ...completion, payload: { ...completion.payload, status: "running" } })}\n`
    );

    await expect(openNdjsonPipelineRunStore(missingStatus)).rejects.toThrow(
      "payload.status must be cancelled, completed, or failed"
    );
    await expect(openNdjsonPipelineRunStore(unsupportedStatus)).rejects.toThrow(
      "payload.status must be cancelled, completed, or failed"
    );
  });

  it("uses the same payload validation for NDJSON and SQLite", async () => {
    const malformed = {
      name: "step.planned",
      payload: {
        dependencies: "load",
        dryRun: "run",
        optionalDependencies: [],
        runtimeSkipPossible: false,
        selected: true,
        selectionReasons: [],
        skipAfterFailureOf: [],
      },
      pipelineId: "import",
      runId: "run-1",
      stepId: "load",
      timestampMs: 1,
      version: 2,
    };
    const filename = await tempFile(`${JSON.stringify(malformed)}\n`);
    await expect(openNdjsonPipelineRunStore(filename)).rejects.toThrow(
      "payload.dependencies must be an array"
    );

    const sqlite = await openSqlitePipelineRunStore(
      path.join(path.dirname(filename), "malformed.sqlite")
    );
    expect(() => {
      // @ts-expect-error Runtime validation must reject untyped adapter input consistently.
      void sqlite.export(malformed);
    }).toThrow("payload.dependencies must be an array");
    expect(() => sqlite.close()).toThrow("payload.dependencies must be an array");
  });

  it.each([
    {
      expected: "error.issues must contain at most 128 entries",
      issues: Array.from({ length: 129 }, () => ({ message: "invalid" })),
    },
    {
      expected: "error.issues[0].message exceeds 4096 code units",
      issues: [{ message: "m".repeat(4_097) }],
    },
    {
      expected: "error.issues[0].path string exceeds 4096 code units",
      issues: [{ message: "invalid", path: ["p".repeat(4_097)] }],
    },
  ])("bounds validation issues consistently: $expected", async ({ expected, issues }) => {
    const malformed: PipelineTraceEvent = {
      error: {
        code: "TUBELESS_OPTIONS_VALIDATION_FAILED",
        issues,
        kind: "validation",
        message: "validation failed",
        phase: "planning",
      },
      name: "pipeline.completed",
      payload: {
        dryRun: false,
        errorCount: 1,
        finalized: false,
        status: "failed",
        stepCount: 0,
      },
      pipelineId: "import",
      runId: "run-1",
      timestampMs: 1,
      version: 2,
    };
    const filename = await tempFile(`${JSON.stringify(malformed)}\n`);
    await expect(openNdjsonPipelineRunStore(filename)).rejects.toThrow(expected);

    const sqlite = await openSqlitePipelineRunStore(
      path.join(path.dirname(filename), "malformed-issues.sqlite")
    );
    expect(() => sqlite.export(malformed)).toThrow(expected);
    expect(() => sqlite.close()).toThrow(expected);
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

  it("round-trips empty error messages and nested cause messages", async () => {
    const { step } = createSteps();
    const failing = step("failing", {
      run: () => {
        const error = new Error() as Error & { cause?: unknown };
        error.cause = new Error();
        throw error;
      },
    });
    const pipeline = definePipeline({
      id: "empty-diagnostic-message",
      steps: [failing],
      finalize: () => undefined,
    });
    const lines: string[] = [];

    const run = await pipeline.run({}, {}, { tracing: { exporter: captureJson(lines) } });
    expect(run.errors[0]).toMatchObject({ message: "", cause: { message: "" } });

    const filename = await tempFile(`${lines.join("\n")}\n`);
    const store = await openNdjsonPipelineRunStore(filename);
    try {
      const events = await store.listEvents();
      expect(events.find((entry) => entry.name === "step.failed")?.error).toMatchObject({
        message: "",
        cause: { message: "" },
      });
      expect(projectPipelineRunStore(events).runs[0]?.error).toMatchObject({
        message: "",
        cause: { message: "" },
      });
    } finally {
      await store.close();
    }
  });
});

describe("recorded fan-out diagnostics", () => {
  it("round-trips real failures through JSON, SQLite, and history projection", async () => {
    const { step: childStep } = createSteps();
    const work = childStep("work", {
      run: () => {
        throw Object.assign(new Error("failed"), { code: "RETRY" });
      },
    });
    const child = definePipeline({ id: "child", steps: [work], finalize: () => true });
    const { forEachPipeline } = createSteps();
    const fan = forEachPipeline("fan", {
      pipeline: child,
      items: () => Array.from({ length: 40 }, (_, index) => index),
      key: (index) => `${index}-${"k".repeat(1024)}`,
      mapOptions: () => ({}),
      concurrency: 3,
    });
    const pipeline = definePipeline({ id: "parent", steps: [fan], finalize: () => true });
    const lines: string[] = [];
    const run = await pipeline.run({}, {}, { tracing: { exporter: captureJson(lines) } });
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
  const failedEvent = () => ({
    ...event("run-1"),
    name: "pipeline.completed",
    payload: {
      dryRun: false,
      errorCount: 1,
      finalized: false,
      status: "failed",
      stepCount: 0,
    },
  });

  it("preserves cancellation, scheduler causes, and empty snapshot strings", async () => {
    const filename = await tempFile(
      JSON.stringify({ ...failedEvent(), error: { ...error, fanOut: diagnostics } })
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
      JSON.stringify({ ...failedEvent(), error: { ...error, fanOut } })
    );
    await expect(openNdjsonPipelineRunStore(filename)).rejects.toThrow("line 1 is invalid");
  });
});

it.each(["completed", "failed", "cancelled"] as const)(
  "round-trips %s override provenance through NDJSON and SQLite",
  async (status) => {
    const { step } = createSteps();
    const test = createPipelineTestRuntime();
    const load = step("load", {
      run: () => "real",
      outputSchema: {
        "~standard": {
          version: 1,
          vendor: "test",
          types: undefined as { input: string; output: string } | undefined,
          validate: (value) => {
            if (status === "cancelled") test.abort();
            return status === "failed"
              ? { issues: [{ message: "Invalid fixture" }] }
              : { value: String(value) };
          },
        },
      },
    });
    const pipeline = definePipeline({ id: "override-history", steps: [load], finalize: load });
    const lines: string[] = [];
    test.context.tracing = { exporter: captureJson(lines) };
    const result = await test.run(
      pipeline,
      {},
      { overrides: [overrideStep(load, "private supplied value")] }
    );
    expect(lines.join("\n")).not.toContain("private supplied value");
    expect(result.steps[0]).toMatchObject({ status, outputSource: "override" });
    const filename = await tempFile(lines.join("\n"));
    const ndjson = await openNdjsonPipelineRunStore(filename);
    const sqlite = await openSqlitePipelineRunStore(
      path.join(path.dirname(filename), "overrides.sqlite")
    );
    try {
      const events = await ndjson.listEvents();
      expect(
        events.find(
          (event) => event.name === (status === "completed" ? "step.complete" : `step.${status}`)
        )
      ).toMatchObject({
        payload: { status, outputSource: "override" },
        stepId: "load",
        attemptId: expect.any(String),
      });
      for (const event of events) await sqlite.export(event);
      await sqlite.flush?.();
      for (const reader of [ndjson, sqlite]) {
        expect(projectPipelineRunStore(await reader.listEvents()).runs[0]?.steps[0]).toMatchObject({
          id: "load",
          status,
          outputSource: "override",
          attempt: { status, outputSource: "override" },
        });
      }
    } finally {
      await ndjson.close();
      await sqlite.close();
    }
  }
);
