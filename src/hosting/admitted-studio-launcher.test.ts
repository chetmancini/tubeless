import { afterEach, expect, it, vi } from "vitest";
import { admittedStudioLauncher } from "./admitted-studio-launcher.js";
import { HostedRunCoordinator } from "./run-coordinator.js";
import { commands } from "./run.test-support.js";
import type { HostedLaunchStatus } from "./launch-admission.js";

function setup(getLaunch: (launchId: string) => Promise<HostedLaunchStatus | undefined>) {
  const coordinator = new HostedRunCoordinator({
    commands,
    maxRunDurationMs: 60_000,
    output: { cwd: "/tmp", stdout: { write: () => {} }, stderr: { write: () => {} } },
    driver: {
      prepare: async (job) => job,
      start: vi.fn(async () => {}),
      failUnadmitted: vi.fn(async () => {}),
      cancel: async () => false,
      liveRunIds: async () => [],
    },
  });
  const launcher = admittedStudioLauncher({
    coordinator,
    projectId: "p",
    deploymentId: "release",
    admit: async () => ({ accepted: true, launchId: "original", job: undefined }),
    getLaunch,
  });
  return { coordinator, launcher };
}
afterEach(() => vi.useRealTimers());

it("observes a replay's concurrent start before reading its previously unstarted state", async () => {
  vi.useFakeTimers();
  const { coordinator, launcher } = setup(async () => {
    coordinator.acknowledge("original", { accepted: true, runId: "committed" });
    return { launchId: "original", commandId: "effect", state: "starting" };
  });
  expect(await launcher.launch("effect", { name: "Ada" })).toEqual({
    accepted: true,
    runId: "committed",
  });
  expect(vi.getTimerCount()).toBe(0);
});

it("settles start observation when replay state cannot be read", async () => {
  vi.useFakeTimers();
  const { launcher } = setup(async () => {
    throw new Error("SQL unavailable");
  });
  expect(await launcher.launch("effect", { name: "Ada" })).toMatchObject({
    accepted: false,
    errors: [expect.stringContaining("check history")],
  });
  expect(vi.getTimerCount()).toBe(0);
});
