import { afterEach, expect, it, vi } from "vitest";
import { createHostedLaunchAdmission } from "./launch-admission.js";
import { createSqliteLaunchStoreFixture } from "./launch-store-sqlite.test-support.js";
import { commands } from "./run.test-support.js";

const fixtures: ReturnType<typeof createSqliteLaunchStoreFixture>[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.store.close();
});

it("gives a dispatch job only to the reservation creator, including concurrent admission and later replay", async () => {
  const fixture = createSqliteLaunchStoreFixture();
  fixtures.push(fixture);
  const admit = createHostedLaunchAdmission({
    projectId: "p",
    deploymentId: "release",
    commands,
    store: fixture.store.admissions,
    output: { cwd: "/tmp", stdout: { write: () => {} }, stderr: { write: () => {} } },
    maxRunDurationMs: 60_000,
    scheduleReconcile: vi.fn(async () => {}),
  });
  const request = {
    projectId: "p",
    deploymentId: "release",
    commandId: "effect",
    values: { name: "Ada" },
    idempotencyKey: "same-key",
  };
  const decisions = await Promise.all([admit(request), admit(request)]);
  expect(decisions.every((decision) => decision.accepted)).toBe(true);
  const jobs = decisions.flatMap((decision) =>
    decision.accepted && decision.job ? [decision.job] : []
  );
  expect(jobs).toHaveLength(1);
  expect(jobs[0]).toMatchObject({
    commandId: "effect",
    values: { name: "Ada", dryRun: false },
    deploymentId: "release",
  });
  expect(await fixture.store.launchStatus(jobs[0]!.launchId)).toMatchObject({ state: "starting" });
  expect(await fixture.events.listEvents()).toEqual([]);
  expect(await admit(request)).toEqual({
    accepted: true,
    launchId: jobs[0]!.launchId,
    job: undefined,
  });
  expect(await admit({ ...request, values: { name: "different" } })).toMatchObject({
    accepted: false,
    code: "idempotency_conflict",
  });
});
