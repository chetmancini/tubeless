import { describe, expect, it } from "vitest";
import {
  createSteps,
  definePipeline,
  isPipelineErrorCode,
  PIPELINE_ERROR_CODES,
  type RemoteStepAdapter,
} from "tubeless";
import { runBatched, runConcurrent } from "tubeless/batch";
import { RateLimiter } from "tubeless/rate-limit";
import { withRetry } from "tubeless/retry";
import {
  composeTraceExporters,
  type PipelineTraceEvent,
  type PipelineTraceExporter,
} from "tubeless/tracing";
import {
  CliValidationError,
  defineCommandCatalog,
  defineCommand,
  definePipelineCommand,
  type CliParamsSchema,
  type CommandCatalog,
  type CommandCatalogEntry,
  type CommandCatalogInput,
} from "tubeless/cli";
import * as cli from "tubeless/cli";
import * as project from "tubeless/project";
import { defineProject, type PipelineProject, type ProjectMetadata } from "tubeless/project";
import { MinimalPipeline, runMinimalExample } from "../../examples/minimal-pipeline.js";

interface ImportOptions {
  lines: readonly string[];
}

const { step } = createSteps<ImportOptions>();

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

const { step: childStep } = createSteps<ChildOptions>();
const childNormalize = childStep("child-normalize", {
  run: (_inputs, context) => context.options.rows.map((row) => row.trim()),
});
const ChildPipeline = definePipeline({
  id: "public-child",
  steps: [childNormalize],
  finalize: (outputs) => outputs["child-normalize"] ?? [],
});

const { fromPipeline } = createSteps<ImportOptions>();
const childStage = fromPipeline("child-stage", {
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

const { step: forEachChildStep } = createSteps<ForEachChildOptions>();
const upper = forEachChildStep("upper", {
  run: (_inputs, context) => context.options.value.toUpperCase(),
});
const ForEachChildPipeline = definePipeline({
  id: "public-foreach-child",
  steps: [upper],
  finalize: (outputs) => outputs.upper ?? "",
});

const { forEachPipeline } = createSteps<ForEachParentOptions>();
const forEachChildren = forEachPipeline("children", {
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

const enrichSchema = {
  "~standard": {
    validate: (value: unknown) =>
      value && typeof value === "object" && "ok" in value && (value as { ok: unknown }).ok === true
        ? { value: value as { ok: true } }
        : { issues: [{ message: "ok" }] },
    vendor: "test",
    version: 1 as const,
  },
};

const { fromRemote: remoteFromRemote } = createSteps<ImportOptions>();
const remoteAdapter: RemoteStepAdapter<ImportOptions, { lines: readonly string[] }, { ok: true }> =
  {
    engine: "test",
    target: "enrich-v2",
    invoke: async () => ({ ok: true as const }),
  };
const remoteEnrich = remoteFromRemote("remote-enrich", {
  adapter: remoteAdapter,
  mapInput: (_inputs, context) => ({ lines: context.options.lines, dryRun: context.dryRun }),
  outputSchema: enrichSchema,
});
const RemotePipeline = definePipeline({
  id: "remote-enrich",
  steps: [remoteEnrich],
  finalize: (outputs) => outputs["remote-enrich"],
});

describe("public API example", () => {
  it("runs the minimal recipe with an inferred target and result", async () => {
    await expect(runMinimalExample()).resolves.toEqual(["Alpha", "Beta"]);
    expect(MinimalPipeline.targetIds).toEqual(["normalize"]);
    await expect(
      MinimalPipeline.runOrThrow({ lines: [" Alpha "] }, { stepIds: ["load"] })
    ).resolves.toBeUndefined();
  });

  it("exposes stable pipeline error codes for discovery and lookup", () => {
    expect(PIPELINE_ERROR_CODES).toContain("TUBELESS_STEP_FAILED");
    expect(isPipelineErrorCode("TUBELESS_STEP_FAILED")).toBe(true);
    expect(isPipelineErrorCode("application_error")).toBe(false);
  });

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

  it("composes a remote step through the package entrypoint", async () => {
    const value = await RemotePipeline.runOrThrow({ lines: ["alpha"] });
    expect(value).toEqual({ ok: true });
    expect(RemotePipeline.plan({}).steps[0]?.remote).toEqual({
      engine: "test",
      target: "enrich-v2",
    });
  });

  it("fans out with forEachPipeline through the package entrypoint", async () => {
    const value = await ForEachParentPipeline.runOrThrow({ items: ["alpha", "beta", "gamma"] });

    expect(value).toEqual(["ALPHA", "BETA", "GAMMA"]);
  });

  it("runs batches and bounded concurrent work through tubeless/batch", async () => {
    await expect(runBatched([1, 2, 3], { size: 2 }, async (batch) => batch)).resolves.toEqual([
      [1, 2],
      [3],
    ]);
    await expect(
      runConcurrent([1, 2], { concurrency: 1 }, async (value) => value * 2)
    ).resolves.toEqual([2, 4]);
  });

  it("schedules once through tubeless/rate-limit", async () => {
    const limiter = new RateLimiter(0);
    await limiter.wait();
  });

  it("exports structured traces through the small observability boundary", async () => {
    const events: PipelineTraceEvent[] = [];
    const event: PipelineTraceEvent = {
      name: "pipeline.completed",
      payload: {
        dryRun: false,
        errorCount: 0,
        finalized: true,
        status: "completed",
        stepCount: 1,
      },
      pipelineId: "import",
      runId: "public-api",
      timestampMs: 1,
      version: 2,
    };
    const exporter: PipelineTraceExporter = { export: (next) => void events.push(next) };
    await composeTraceExporters([exporter, { export: () => undefined }]).export(event);

    expect(events).toEqual([event]);
  });

  it("runs standalone typed commands through tubeless/cli", async () => {
    const params = { count: { type: "number" } } satisfies CliParamsSchema;
    const command = defineCommand({
      name: "count",
      params,
      run: (values) => ({ count: values.count, dryRun: values.dryRun }),
    });

    await expect(command.run(["--count", "3", "--dry-run"])).resolves.toEqual({
      count: 3,
      dryRun: true,
    });
    await expect(command.run(["--count", "invalid"])).rejects.toBeInstanceOf(CliValidationError);
  });

  it("keeps terminal commands and project catalogs on distinct public entrypoints", () => {
    expect(cli).toHaveProperty("defineCommandCatalog");
    expect(Object.keys(project).sort()).toEqual(["PipelineDocumentError", "defineProject"]);
  });

  it("registers CLI commands in a project catalog", () => {
    const command = definePipelineCommand(ImportPipeline, {
      params: {
        lines: { type: "string", multiple: true },
      },
      reporter: false,
    });
    const entry: CommandCatalogEntry = {
      id: "import",
      file: "./import.ts",
      export: "ImportCommand",
    };
    const input: CommandCatalogInput = { commands: [entry] };
    const catalog: CommandCatalog = defineCommandCatalog(input);

    expect(command.descriptor.name).toBe("import");
    expect(catalog.commands[0]?.id).toBe("import");
  });

  it("defines a typed project from pipelines", async () => {
    const metadata: ProjectMetadata = {
      name: "Public API jobs",
      description: "Import and normalize rows.",
    };
    const project: PipelineProject<
      "public-api",
      readonly [typeof ImportPipeline, typeof ChildPipeline]
    > = defineProject("public-api", [ImportPipeline, ChildPipeline], metadata);

    expect(project.id).toBe("public-api");
    expect(project.name).toBe("Public API jobs");
    expect(project.description).toBe("Import and normalize rows.");
    expect(project.pipelineIds).toEqual(["import", "public-child"]);
    await expect(project.get("import").runOrThrow({ lines: [" Alpha "] })).resolves.toEqual({
      count: 1,
      rows: ["alpha"],
    });
  });
});
