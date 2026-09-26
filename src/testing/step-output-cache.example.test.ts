import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createPipelineTestRuntime } from "tubeless/testing";
import { CachedCountPipeline } from "../../examples/step-output-cache.js";

it("reuses the public recipe's default cache across runs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tubeless-cache-recipe-"));
  try {
    const test = createPipelineTestRuntime();
    test.context.cwd = directory;
    expect((await test.run(CachedCountPipeline, { text: "hello" })).value).toBe(5);
    const hit = await test.run(CachedCountPipeline, { text: "hello" });
    expect(hit.value).toBe(5);
    expect(hit.steps[1]).toMatchObject({ status: "completed", outputSource: "cache" });
    expect(
      (await test.run(CachedCountPipeline, { text: "hello" }, { cache: "recompute" })).steps[1]
        ?.outputSource
    ).toBeUndefined();
    expect((await test.run(CachedCountPipeline, { text: "" })).value).toBe(0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
