import { describe, expect, it } from "vitest";
import { PELOTON_RIDERS, PelotonPipeline, type PelotonResult } from "../examples/peloton";
import { createPipelineTestRuntime } from "./testing";

const fixture = {
  concurrency: 2,
  delay: 0,
  refresh: false,
  riders: PELOTON_RIDERS,
} as const;

function completedIds(result: { steps: readonly { id: string; status: string }[] }): string[] {
  return result.steps.filter((step) => step.status === "completed").map((step) => step.id);
}

function skippedIds(result: { steps: readonly { id: string; status: string }[] }): string[] {
  return result.steps.filter((step) => step.status === "skipped").map((step) => step.id);
}

describe("peloton example", () => {
  it("verifies the full pipeline without delays", async () => {
    const planned = PelotonPipeline.plan({ targets: ["publish-start-list"] });
    expect(planned.ok).toBe(true);
    expect(planned.pipelineId).toBe("peloton");
    expect(planned.steps.filter((step) => step.selected).map((step) => step.id)).toEqual(
      expect.arrayContaining([
        "discover-peloton",
        "resolve-weather",
        "normalize-bikes",
        "inspect-bikes",
        "validate-tech",
        "publish-start-list",
      ])
    );
    expect(planned.steps.find((step) => step.id === "audit-cars")?.selected).toBe(false);
    expect(PelotonPipeline.toMermaid({ direction: "LR" })).toContain("-->");

    const test = createPipelineTestRuntime({ cwd: "/workspace" });
    const value = await test.runOrThrow(PelotonPipeline, fixture);

    const expected: PelotonResult = {
      auditCars: 2,
      inspected: 3,
      publishedId: "start-list-3",
      riders: 3,
      valid: true,
      weather: "dry",
    };
    expect(value).toEqual(expected);
    expect(test.clock.now()).toBe(0);
    expect(test.logs.some((entry) => String(entry.message).includes("race radio"))).toBe(true);
    expect(
      test.logs.some(
        (entry) => entry.level === "warn" && String(entry.message).includes("radio drop")
      )
    ).toBe(true);
    expect(test.latestProgress.get("discover-peloton")).toEqual(
      expect.objectContaining({ completed: 3, total: 3 })
    );
    expect(
      completedIds({
        steps: test.statuses.map((event) => ({ id: event.step.id, status: event.status })),
      })
    ).toEqual(
      expect.arrayContaining([
        "discover-peloton",
        "resolve-weather",
        "normalize-bikes",
        "inspect-bikes",
        "audit-cars",
        "validate-tech",
        "publish-start-list",
      ])
    );

    const cached = await PelotonPipeline.runOrThrow({
      ...fixture,
      cachedWeather: "wet",
    });
    expect(cached.weather).toBe("wet");

    const dry = await PelotonPipeline.run({
      ...fixture,
      dryRun: true,
    });
    expect(dry.status).toBe("completed");
    expect(dry.value).toEqual({
      auditCars: 2,
      inspected: 3,
      publishedId: undefined,
      riders: 3,
      valid: true,
      weather: "dry",
    });
    expect(skippedIds(dry)).toEqual(expect.arrayContaining(["publish-start-list"]));

    const bestEffort = await PelotonPipeline.run({
      ...fixture,
      continueOnError: true,
      failAudit: true,
    });
    expect(bestEffort.status).toBe("failed");
    expect(bestEffort.value).toEqual({
      auditCars: undefined,
      inspected: 3,
      publishedId: "start-list-3",
      riders: 3,
      valid: true,
      weather: "dry",
    });
    expect(bestEffort.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "audit-cars", status: "failed" }),
        expect.objectContaining({ id: "inspect-bikes", status: "completed" }),
        expect.objectContaining({ id: "publish-start-list", status: "completed" }),
      ])
    );
  });
});
