import { afterEach, expect, it } from "vitest";
import { createHostedLaunchAdmission } from "./launch-admission.js";
import { createSqliteLaunchStoreFixture } from "./launch-store-sqlite.test-support.js";
import { commands } from "./run.test-support.js";

const fixtures: ReturnType<typeof createSqliteLaunchStoreFixture>[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.store.close();
});

it("enqueues one pinned job for concurrent admissions and later replay", async () => {
  const fixture = createSqliteLaunchStoreFixture();
  fixtures.push(fixture);
  const admit = createHostedLaunchAdmission({
    projectId: "p",
    deploymentId: "release",
    commands,
    store: fixture.store.admissions,
    output: { cwd: "/tmp", stdout: { write: () => {} }, stderr: { write: () => {} } },
    maxRunDurationMs: 60_000,
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
  const now = Date.now();
  const actions = fixture.storage.transactionSync(() =>
    fixture.store.executions.takeDue(now, now + 1_000)
  );
  expect(actions).toEqual([
    {
      kind: "dispatch",
      launchId: expect.any(String),
      job: expect.objectContaining({
        commandId: "effect",
        values: expect.objectContaining({ name: "Ada", dryRun: false }),
        deploymentId: "release",
      }),
    },
  ]);
  const launchId = actions[0].launchId;
  expect(decisions).toEqual(
    Array.from({ length: 2 }, () => ({ accepted: true, launchId, job: undefined }))
  );
  expect(await fixture.store.launchStatus(launchId)).toMatchObject({ state: "starting" });
  expect(await fixture.events.listEvents()).toEqual([]);
  expect(await admit(request)).toEqual({
    accepted: true,
    launchId,
    job: undefined,
  });
  expect(await admit({ ...request, values: { name: "different" } })).toMatchObject({
    accepted: false,
    code: "idempotency_conflict",
  });
});
