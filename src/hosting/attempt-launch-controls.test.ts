import { afterEach, expect, it } from "vitest";
import {
  collectorFixture,
  definition,
  started,
  completed,
  batch,
  encode,
} from "./collector.test-support.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
});

it("scopes owned liveness and root cancellation without enrolling attempts in trusted recovery", async () => {
  const { store, authority } = await collectorFixture();
  cleanups.push(() => store.close());
  await store.claimCollectorAttempt(authority, "worker", "release-1");
  await store.acceptCollectorBatch(
    authority,
    "worker",
    batch(0, [started(), started("child", "root")])
  );
  const other = { launchId: "other", attemptId: "other", workerId: "other" };
  await store.createAttempt({ ...definition, ...other, deploymentId: "release-2" });
  await store.claimAttempt(other, "release-2", 101);
  await store.acceptAttemptBatch(
    other,
    encode({ attemptId: "other", sequence: 0, events: [started("other-root")] })
  );
  await store.create("trusted", "pipeline", 100);
  await store.acceptBatch("trusted", 0, [started("trusted-root")]);
  expect(await store.liveAttemptRunIds("release-1")).toEqual(["root"]);
  expect(await store.liveAttemptRunIds("release-2")).toEqual(["other-root"]);
  expect(await store.liveRunIds()).toEqual(["trusted-root"]);
  expect(await store.stale(10_000)).toEqual(["trusted"]);
  for (const runId of ["child", "other-root", "trusted-root", "unknown"])
    expect(await store.requestAttemptRunCancellation(runId, "release-1")).toBe(false);
  expect(await store.collectorCancellationRequested(authority, "worker")).toBe(false);
  expect(await store.requestAttemptRunCancellation("root", "release-1")).toBe(true);
  expect(await store.requestAttemptRunCancellation("root", "release-1")).toBe(true);
  expect(await store.collectorCancellationRequested(authority, "worker")).toBe(true);
  await store.acceptCollectorBatch(authority, "worker", batch(1, [completed()]));
  expect(await store.liveAttemptRunIds("release-1")).toEqual([]);
  expect(await store.requestAttemptRunCancellation("root", "release-1")).toBe(false);
  expect(await store.liveAttemptRunIds("release-2")).toEqual(["other-root"]);
});
