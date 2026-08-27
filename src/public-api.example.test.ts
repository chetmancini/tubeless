import { describe, expect, it } from "vitest";
import { createSteps, definePipeline, type PipelineLogger, type PipelineRun } from "tubeless";
import { createPipelineReporter, createRunReporter } from "tubeless/reporter";
import { chunk, runConcurrent } from "tubeless/batch";
import { parseMultiSelectInput, TUBELESS_WORKBENCH_EXIT_CODE } from "tubeless/cli";
import { definePaths, requireEnv } from "tubeless/node";
import { RateLimiter } from "tubeless/rate-limit";
import { withRetry } from "tubeless/retry";
import type { PipelineTraceEvent } from "tubeless/tracing";
import { createJsonTraceExporter } from "tubeless/tracing/json";
import { createOpenTelemetryTraceExporter } from "tubeless/tracing/otel";

interface ImportOptions {
  lines: readonly string[];
}

const step = createSteps<ImportOptions>();

const loadRows = step("load-rows", {
  run: (_inputs, context) => context.options.lines,
});

const normalizeRows = step("normalize-rows", {
  dependsOn: [loadRows],
  run: ({ "load-rows": rows }) =>
    rows.map((row) => row.trim().toLowerCase()).filter((row) => row.length > 0),
});

const ImportPipeline = definePipeline({
  id: "import",
  steps: [loadRows, normalizeRows],
  targets: [normalizeRows],
  finalize: (outputs) => ({
    count: outputs["normalize-rows"]?.length ?? 0,
    rows: outputs["normalize-rows"] ?? [],
  }),
});

interface ChildOptions {
  rows: readonly string[];
}

const childStep = createSteps<ChildOptions>();
const childNormalize = childStep("child-normalize", {
  run: (_inputs, context) => context.options.rows.map((row) => row.trim()),
});
const ChildPipeline = definePipeline({
  id: "public-child",
  steps: [childNormalize],
  finalize: (outputs) => outputs["child-normalize"] ?? [],
});

const parentStep = createSteps<ImportOptions>();
const childStage = parentStep.fromPipeline("child-stage", {
  pipeline: ChildPipeline,
  mapOptions: (_inputs, context) => ({ rows: context.options.lines }),
});
const ParentPipeline = definePipeline({
  id: "public-parent",
  steps: [childStage],
  finalize: (outputs) => outputs["child-stage"],
});

interface ForEachParentOptions {
  items: readonly string[];
}

interface ForEachChildOptions {
  value: string;
}

const forEachChildStep = createSteps<ForEachChildOptions>();
const upper = forEachChildStep("upper", {
  run: (_inputs, context) => context.options.value.toUpperCase(),
});
const ForEachChildPipeline = definePipeline({
  id: "public-foreach-child",
  steps: [upper],
  finalize: (outputs) => outputs.upper ?? "",
});

const forEachParentStep = createSteps<ForEachParentOptions>();
const forEachChildren = forEachParentStep.forEachPipeline("children", {
  pipeline: ForEachChildPipeline,
  items: (_inputs, context) => context.options.items,
  key: (item) => item,
  mapOptions: (item) => ({ value: item }),
});
const ForEachParentPipeline = definePipeline({
  id: "public-foreach-parent",
  steps: [forEachChildren],
  finalize: (outputs) => outputs.children,
});

function capturingLogger(): PipelineLogger & {
  messages: { error: string[]; log: string[]; warn: string[] };
} {
  const messages = { error: [] as string[], log: [] as string[], warn: [] as string[] };
  return {
    messages,
    log: (message?: unknown) => messages.log.push(String(message ?? "")),
    warn: (message?: unknown) => messages.warn.push(String(message ?? "")),
    error: (message?: unknown) => messages.error.push(String(message ?? "")),
  };
}

describe("public API example", () => {
  it("runs a neutral import pipeline through the package entrypoint", async () => {
    const result = await ImportPipeline.runOrThrow({
      lines: [" Alpha ", "", "Beta"],
    });

    expect(result).toEqual({ count: 2, rows: ["alpha", "beta"] });
    expect(ImportPipeline.targetIds).toEqual(["normalize-rows"]);
  });

  it("uses a public helper subpath", async () => {
    const value = await withRetry(async () => "ok", { maxAttempts: 1, baseDelayMs: 0 });

    expect(value).toBe("ok");
  });

  it("composes a child through the package entrypoint", async () => {
    const value = await ParentPipeline.runOrThrow({ lines: [" Alpha ", "Beta "] });

    expect(value).toEqual(["Alpha", "Beta"]);
  });

  it("fans out with forEachPipeline through the package entrypoint", async () => {
    const value = await ForEachParentPipeline.runOrThrow({ items: ["alpha", "beta", "gamma"] });

    expect(value).toEqual(["ALPHA", "BETA", "GAMMA"]);
  });

  it("chunks and runs bounded concurrent work through tubeless/batch", async () => {
    expect(chunk([1, 2, 3], 2)).toEqual([[1, 2], [3]]);
    await expect(
      runConcurrent([1, 2], { concurrency: 1 }, async (value) => value * 2)
    ).resolves.toEqual([2, 4]);
  });

  it("parses multi-select input through tubeless/cli", () => {
    expect(parseMultiSelectInput("1 2", ["a", "b"])).toEqual({
      kind: "values",
      values: ["a", "b"],
    });
    expect(TUBELESS_WORKBENCH_EXIT_CODE).toMatchObject({
      success: 0,
      usage: 1,
      load: 2,
      definition: 3,
      validation: 4,
      planning: 5,
      execution: 6,
      cancellation: 7,
    });
  });

  it("resolves paths and env through tubeless/node", () => {
    const paths = definePaths({ tmp: "tmp" })("/workspace");
    expect(paths.tmp).toMatch(/[/\\]workspace[/\\]tmp$/);

    const previous = process.env.TUBELESS_CORE_PUBLIC_API_SMOKE_ENV;
    process.env.TUBELESS_CORE_PUBLIC_API_SMOKE_ENV = "smoke-value";
    try {
      expect(requireEnv("TUBELESS_CORE_PUBLIC_API_SMOKE_ENV", "public-api-smoke")).toBe(
        "smoke-value"
      );
    } finally {
      if (previous === undefined) {
        delete process.env.TUBELESS_CORE_PUBLIC_API_SMOKE_ENV;
      } else {
        process.env.TUBELESS_CORE_PUBLIC_API_SMOKE_ENV = previous;
      }
    }
  });

  it("schedules once through tubeless/rate-limit", async () => {
    const limiter = new RateLimiter(0);
    await limiter.wait();
  });

  it("exports structured traces through the documented public subpaths", () => {
    const lines: string[] = [];
    const event: PipelineTraceEvent = {
      attributes: {},
      name: "pipeline.completed",
      pipelineId: "import",
      runId: "public-api",
      timestampMs: 1,
      version: 1,
    };
    createJsonTraceExporter({ write: (line) => lines.push(line) }).export(event);

    const span = { addEvent: () => undefined, end: () => undefined };
    const exporter = createOpenTelemetryTraceExporter({
      tracer: { startSpan: () => span },
    });
    exporter.export(event);

    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({ pipelineId: "import" });
  });

  it("creates plain pipeline reporters through the package entrypoint", async () => {
    const logger = capturingLogger();
    const reporter = createPipelineReporter({
      color: "never",
      log: logger,
      mode: "plain",
      symbols: "ascii",
    });
    expect(reporter.mode).toBe("plain");

    const result = await ImportPipeline.run(
      { lines: ["one"] },
      {
        cwd: "/tmp",
        hooks: createRunReporter({
          color: "never",
          log: logger,
          symbols: "ascii",
        }),
        log: logger,
      }
    );

    expect(result.status).toBe("completed");
    const publicRun: PipelineRun<{ count: number; rows: string[] }> = result;
    expect(publicRun.steps[0]?.attemptId).toMatch(new RegExp(`^${result.runId}:attempt:`));
    expect(logger.messages.log.some((line) => line.includes("Pipeline import"))).toBe(true);
    reporter.dispose();
  });
});
