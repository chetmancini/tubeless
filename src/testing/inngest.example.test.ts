import { InngestTestEngine, mockCtx } from "@inngest/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { inngest } from "../../examples/inngest/client.js";
import { normalizeFunction } from "../../examples/inngest/functions.js";
import { InngestPipeline } from "../../examples/inngest/pipeline.js";

afterEach(() => vi.restoreAllMocks());

const job = { lines: [" Alpha ", "", "Beta", "ALPHA"] };

function environment(data: unknown = job, attempt = 0) {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  vi.spyOn(inngest.logger, "info").mockImplementation(logger.info);
  vi.spyOn(inngest.logger, "warn").mockImplementation(logger.warn);
  vi.spyOn(inngest.logger, "error").mockImplementation(logger.error);
  const engine = new InngestTestEngine({
    function: normalizeFunction,
    transformCtx: (ctx) => ({
      ...mockCtx(ctx),
      event: { ...ctx.event, name: "tubeless/normalize.requested", data },
      runId: "inngest-run-1",
      attempt,
    }),
  });
  return { engine, logger };
}

describe("Inngest durable step recipe", () => {
  it("runs the pipeline inside step.run with correlated progress and traces", async () => {
    const { engine, logger } = environment({ ...job, parentRunId: "parent:execution-1" });
    const execute = vi.spyOn(InngestPipeline, "runOrThrow");
    const { result, error, ctx } = await engine.execute();
    expect(error).toBeUndefined();
    expect(result).toMatchObject({ rows: ["alpha", "beta"], count: 2, preview: false });
    expect(result).toMatchObject({ runId: expect.stringMatching(/^inngest-normalize:/) });
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(ctx.step.run).toHaveBeenCalledWith("run-pipeline", expect.any(Function));
    expect(logger.info).toHaveBeenCalledWith(
      "Tubeless progress",
      expect.objectContaining({ stepId: "normalize", completed: 4, total: 4 })
    );
    expect(logger.info).toHaveBeenCalledWith("Tubeless event", {
      event: expect.objectContaining({
        name: "pipeline.started",
        runId: expect.stringMatching(/^inngest-normalize:/),
        parentRunId: "parent:execution-1",
        correlationId: JSON.stringify(["inngest", "inngest-run-1", "run-pipeline"]),
      }),
    });
    expect(logger.info).toHaveBeenCalledWith("Tubeless event", {
      event: expect.objectContaining({ name: "pipeline.completed" }),
    });
  });

  it("returns saved durable step output without starting another pipeline", async () => {
    const { engine } = environment();
    const { result: saved } = await engine.executeStep("run-pipeline");
    const execute = vi.spyOn(InngestPipeline, "runOrThrow");
    const { result } = await engine.execute({
      steps: [{ id: "run-pipeline", handler: () => saved }],
    });
    expect(result).toEqual(saved);
    expect(execute).not.toHaveBeenCalled();
  });

  it("forwards dry-run controls without inventing a Tubeless parent", async () => {
    const { engine, logger } = environment({ ...job, dryRun: true });
    const { result } = await engine.execute();
    expect(result).toMatchObject({ preview: true });
    const start = logger.info.mock.calls.find(
      ([message, metadata]) =>
        message === "Tubeless event" && metadata.event.name === "pipeline.started"
    );
    expect(start?.[1].event).not.toHaveProperty("parentRunId");
  });

  it.each([
    null,
    {},
    { lines: [42] },
    { lines: [], dryRun: "true" },
    { lines: [], parentRunId: "" },
  ])("rejects invalid event data %j before Tubeless wraps the error", async (data) => {
    const { engine } = environment(data);
    const execute = vi.spyOn(InngestPipeline, "runOrThrow");
    const { error } = await engine.executeStep("run-pipeline");
    expect(error).toMatchObject({ name: "NonRetriableError" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("lets a real execution failure escape and reruns all steps on the next attempt", async () => {
    const first = environment();
    // Fail the second domain step after normalization has completed.
    first.logger.info.mockImplementation((message) => {
      if (message === "Normalized 2 distinct rows") throw new Error("Temporary host failure");
    });
    const { error } = await first.engine.executeStep("run-pipeline");
    expect(error).toMatchObject({ name: "PipelineExecutionError" });

    const second = environment(job, 1);
    const { result } = await second.engine.execute();
    expect(result).toMatchObject({ rows: ["alpha", "beta"] });
    for (const { logger } of [first, second]) {
      expect(logger.info).toHaveBeenCalledWith(
        "Tubeless progress",
        expect.objectContaining({ stepId: "normalize", completed: 4 })
      );
    }
    const start = (logger: typeof first.logger) =>
      logger.info.mock.calls.find(
        ([message, metadata]) =>
          message === "Tubeless event" && metadata.event.name === "pipeline.started"
      )?.[1].event;
    expect(start(first.logger).correlationId).toBe(start(second.logger).correlationId);
    expect(result).not.toMatchObject({ runId: start(first.logger).runId });
  });
});
