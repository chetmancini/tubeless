import { afterEach, expect, it } from "vitest";
import { createSqliteLaunchStoreFixture } from "./launch-store-sqlite.test-support.js";
import { SqliteHostedLaunchStore } from "./launch-store-sqlite.js";

const fixtures: ReturnType<typeof createSqliteLaunchStoreFixture>[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.store.close();
});

it("atomically binds a key to its launch and returns the original record after adapter recreation", async () => {
  const fixture = createSqliteLaunchStoreFixture();
  fixtures.push(fixture);
  const { store, storage, events, readLaunch } = fixture;
  const request = {
    idempotencyKey: "daily",
    intentDigest: "digest",
    deploymentId: "release",
    launchId: "launch",
    commandId: "demo",
    createdAtMs: 100,
    metadata: {
      launchId: "launch",
      commandId: "demo",
      trigger: "code" as const,
      inputs: { recorded: [], omitted: ["secret"] },
    },
  };
  const admission = {
    launchId: "launch",
    commandId: "demo",
    intentDigest: "digest",
    deploymentId: "release",
  };
  expect(await store.admissions.reserve(request)).toEqual({ created: true, admission });
  const reopened = new SqliteHostedLaunchStore(storage, events);
  expect(await reopened.admissions.get("daily")).toEqual(admission);
  expect(await reopened.admissions.reserve({ ...request, launchId: "ignored" })).toEqual({
    created: false,
    admission,
  });
  expect(readLaunch("ignored")).toBeUndefined();
  // Intent comparison belongs to the admission policy, not this persistence port.
  expect(
    await reopened.admissions.reserve({ ...request, intentDigest: "changed", launchId: "other" })
  ).toEqual({ created: false, admission });
  expect(readLaunch("other")).toBeUndefined();
  storage.sql.exec(
    "CREATE TRIGGER reject_admission BEFORE INSERT ON tubeless_launch_admissions BEGIN SELECT RAISE(ABORT, 'admission failed'); END"
  );
  await expect(
    store.admissions.reserve({
      ...request,
      idempotencyKey: "new",
      launchId: "rolled-back",
      metadata: { ...request.metadata, launchId: "rolled-back" },
    })
  ).rejects.toThrow("admission failed");
  expect(readLaunch("rolled-back")).toBeUndefined();
  expect(storage.sql.exec("SELECT launch_id FROM tubeless_launch_metadata").toArray()).toEqual([
    { launch_id: "launch" },
  ]);
  storage.sql.exec("DROP TRIGGER reject_admission");
  await expect(
    store.admissions.reserve({
      ...request,
      idempotencyKey: "invalid",
      launchId: "bad",
      metadata: { ...request.metadata, launchId: "bad", trigger: "invalid" as never },
    })
  ).rejects.toThrow();
  expect(readLaunch("bad")).toBeUndefined();
  expect(await store.admissions.get("invalid")).toBeUndefined();
});
