import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

// Execute the real YAML loader in Bun while using the public deterministic
// test runtime. No timers, network requests, or publication side effects.
function check(program: string) {
  const result = spawnSync(
    "bun",
    [
      "-e",
      `
    import assert from "node:assert/strict";
    import { createPipelineTestRuntime } from "tubeless/testing";
    import { YamlPelotonPipeline as pipeline, YamlPelotonCommand as command } from "./examples/yaml-peloton.ts";
    const test = createPipelineTestRuntime();
    const options = { delay: 10, concurrency: 2, failAudit: false, failTech: false };
    ${program}
  `,
    ],
    { encoding: "utf8", timeout: 10000 }
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr || result.stdout).toBe(0);
}

describe("YAML Peloton example", () => {
  it("reports real concurrent progress and retries before publishing", () =>
    check(`
    const value = await test.runOrThrow(pipeline, options);
    assert.deepEqual(value, { riders: 3, inspected: 3, auditCars: 2, valid: true, weather: "dry", publishedId: "start-list-3" });
    assert.equal(test.logs.filter(entry => String(entry.message).includes("race radio drop")).length, 1);
    assert(test.logs.some(entry => String(entry.message).includes("wheels, cage")));
    const progress = test.statuses.filter(event => event.step.id === "inspect-bikes" && event.status === "running" && event.progress).map(event => event.progress);
    assert(progress.length > 0);
    assert(progress.some(item => item.details.filter(detail => detail.status === "running").length === 2));
    assert(progress.every(item => item.details.filter(detail => detail.status === "running").length <= 2));
    assert(progress.every(item => item.completed === item.details.filter(detail => detail.status === "completed").length));
    assert.equal(test.latestProgress.get("inspect-bikes").completed, 3);
    assert(test.latestProgress.get("inspect-bikes").details.every(detail => detail.status === "completed"));
  `));

  it("uses a custom forecast and skips publication in dry runs", () =>
    check(`
    const result = await test.run(pipeline, options, { dryRun: true });
    assert.equal(result.status, "completed");
    assert.equal(result.value.weather, "forecast-dry");
    assert.equal(result.value.valid, true);
    assert.equal(result.value.publishedId, undefined);
    assert.equal(result.steps.find(step => step.id === "publish-start-list").reason, "dry-run");
    assert(!test.logs.some(entry => String(entry.message).includes("simulated publish:")));
    assert(!test.logs.some(entry => String(entry.message).includes("reading the simulated weather station")));
  `));

  it("pulls in the tech gate but omits the independent audit for publication targets", () =>
    check(`
    const plan = pipeline.plan({ targets: ["publish-start-list"] });
    assert.equal(plan.ok, true);
    assert.equal(plan.steps.find(step => step.id === "validate-tech").selected, true);
    assert.equal(plan.steps.find(step => step.id === "audit-cars").selected, false);
    assert.equal(test.statuses.length, 0);
    assert.match(pipeline.toMermaid(), /-->/);
    const result = await test.run(pipeline, { ...options, failAudit: true }, { targets: ["publish-start-list"] });
    assert.equal(result.status, "completed");
    assert.equal(result.value.publishedId, "start-list-3");
    assert.equal(result.value.auditCars, undefined);
    const validation = await test.run(pipeline, options, { targets: ["validate-tech"] });
    assert.equal(validation.value.valid, true);
    assert.equal(validation.value.publishedId, undefined);
  `));

  it("blocks publication after tech failure even with continueOnError", () =>
    check(`
    const result = await test.run(pipeline, { ...options, failTech: true }, { continueOnError: true });
    assert.equal(result.status, "failed");
    assert.equal(result.steps.find(step => step.id === "validate-tech").status, "failed");
    assert.equal(result.steps.find(step => step.id === "publish-start-list").status, "skipped");
    assert.equal(result.value.publishedId, undefined);
    assert(!test.logs.some(entry => String(entry.message).includes("simulated publish:")));
  `));

  it("allows publication after an independent audit failure under continueOnError", () =>
    check(`
    const result = await test.run(pipeline, { ...options, failAudit: true }, { continueOnError: true });
    assert.equal(result.status, "failed");
    assert.equal(result.steps.find(step => step.id === "audit-cars").status, "failed");
    assert.equal(result.value.auditCars, undefined);
    assert.equal(result.value.publishedId, "start-list-3");
  `));

  it("validates options before starting steps and supports Studio form values", () =>
    check(`
    const invalid = await test.run(pipeline, { ...options, concurrency: 0 });
    assert.equal(invalid.status, "failed");
    assert(invalid.errors.some(error => error.code === "TUBELESS_OPTIONS_VALIDATION_FAILED"));
    assert.equal(test.logs.length, 0);
    assert.equal(command.parseValues({ delay: 0, concurrency: 2, "fail-tech": true }).kind, "values");
    assert.equal(command.parseValues({ delay: -1 }).kind, "error");
    assert.match(JSON.stringify(command.descriptor), /fail-audit/);
  `));

  it("forwards cancellation through in-flight inspection sleeps", () =>
    check(`
    const hooks = test.context.hooks;
    let inspecting = false;
    const sleep = test.context.sleep;
    test.context.sleep = async (ms, signal) => {
      if (inspecting) {
        test.abort();
        signal.throwIfAborted();
      }
      await sleep(ms, signal);
    };
    test.context.hooks = { ...hooks, onStepStart(event) {
      hooks?.onStepStart?.(event);
      if (event.step.id === "inspect-bikes") inspecting = true;
    } };
    const result = await test.run(pipeline, options);
    assert.equal(result.status, "cancelled");
    assert.equal(result.value?.publishedId, undefined);
    assert(!test.logs.some(entry => String(entry.message).includes("simulated publish:")));
  `));
});
