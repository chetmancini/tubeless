import { describe, expect, it } from "vitest";
import {
  decodeNodeCheckPartitionPlan,
  digestNodeCheckFileRequest,
  digestNodeCheckPartitionPlan,
  digestNodeCheckPartitionTimingContext,
  planNodeCheckPartitions,
  verifyNodeCheckPartitionCoverage,
  type NodeCheckFileInventory,
  type NodeCheckPartitionEvidence,
  type NodeCheckPartitionTimingObservation,
} from "../node-check-plan.js";

const hash = (letter: string) => letter.repeat(42) + "A";
const inventory: NodeCheckFileInventory = {
  version: 1,
  complete: true,
  files: ["a.js", "b.js", "c.js", "d.js"],
  stepId: "test",
  planDigest: hash("a"),
  source: { commit: null, treeSha: null, lockfileDigest: hash("b") },
  toolchain: { node: "24.22.3", bun: "1.4.4", vitest: "5.1.0", platform: "linux", arch: "x64" },
  configuration: { path: "vite.config.ts", digest: hash("c") },
};
const full = { version: 1, mode: "full", stepId: "test" } as const;
const selected = { version: 1, mode: "selected", stepId: "test" } as const;
const timingContext = {
  sourceDigest: hash("d"),
  configurationDigest: hash("e"),
  environmentDigest: hash("f"),
};
const contextDigest = await digestNodeCheckPartitionTimingContext(inventory, timingContext);
const observation = (
  path: string,
  durationMs: number | null,
  patch: Partial<NodeCheckPartitionTimingObservation> = {}
): NodeCheckPartitionTimingObservation => ({
  path,
  durationMs,
  metric: "vitest-module-tests-and-hooks",
  sampleId: "run-1",
  contextDigest,
  eligible: true,
  identity: "unique-specification",
  ...patch,
});

describe("file partition planning", () => {
  it("assigns long files first with canonical file, load and partition ties", async () => {
    const observations = [
      observation("a.js", 3000.2),
      observation("b.js", 2000),
      observation("c.js", 2000, { sampleId: "b" }),
      observation("c.js", 2000, { sampleId: "a" }),
      observation("d.js", 1000),
    ];
    const request = { ...selected, files: [...inventory.files] };
    const plan = await planNodeCheckPartitions(inventory, request, {
      partitions: 2,
      timingContext,
      observations,
    });
    expect(
      plan.partitions.map(({ id, estimatedMs, files }) => [
        id,
        estimatedMs,
        files.map(({ path }) => path),
      ])
    ).toEqual([
      [1, 4001, ["a.js", "d.js"]],
      [2, 4000, ["b.js", "c.js"]],
    ]);
    expect(plan.partitions[1].files[1].estimate).toMatchObject({ sampleId: "a" });
    const equivalent = await planNodeCheckPartitions(
      { ...inventory, files: [...inventory.files].reverse() },
      { ...request, files: [...request.files].reverse() },
      { partitions: 2, timingContext, observations: [...observations].reverse() }
    );
    expect(equivalent).toEqual(plan);
    expect(await digestNodeCheckPartitionPlan(equivalent)).toBe(
      await digestNodeCheckPartitionPlan(plan)
    );
    expect(await decodeNodeCheckPartitionPlan(plan)).toEqual(plan);
  });

  it("keeps zero and prefers eligible measured durations over legacy sums", async () => {
    const plan = await planNodeCheckPartitions(inventory, full, {
      partitions: 3,
      timingContext,
      observations: [
        observation("a.js", 0),
        observation("a.js", 9000, { metric: "sum-of-final-test-durations" }),
        observation("b.js", 2100, { metric: "sum-of-final-test-durations" }),
        observation("b.js", 10000, { sampleId: "failed", eligible: false }),
        observation("c.js", 4000, {
          metric: "sum-of-final-test-durations",
          identity: "report-path",
        }),
      ],
    });
    const files = Object.fromEntries(
      plan.partitions.flatMap(({ files }) => files.map((file) => [file.path, file]))
    );
    expect(files).toMatchObject({
      "a.js": { estimatedMs: 0, estimate: { metric: "vitest-module-tests-and-hooks" } },
      "b.js": { estimatedMs: 2100, estimate: { metric: "sum-of-final-test-durations" } },
      "c.js": { estimatedMs: 2100, estimate: { reason: "unusable-observation" } },
      "d.js": { estimatedMs: 2100, estimate: { reason: "missing" } },
    });
    const zero = await planNodeCheckPartitions(inventory, full, {
      partitions: 4,
      timingContext,
      observations: inventory.files.map((path) => observation(path, 0)),
    });
    expect(zero.partitions.map(({ files }) => files.map(({ path }) => path))).toEqual(
      inventory.files.map((path) => [path])
    );
  });

  it("falls back on unknown and mismatched context, missing durations and ineligible samples", async () => {
    const observations = [
      observation("a.js", 9999, { contextDigest: null }),
      observation("b.js", 9999, { contextDigest: hash("g") }),
      observation("c.js", null),
      observation("d.js", 9999, { eligible: false }),
    ];
    const plan = await planNodeCheckPartitions(inventory, full, {
      partitions: 1,
      timingContext,
      observations,
    });
    expect(
      plan.partitions[0].files.map(({ estimatedMs, estimate }) => [estimatedMs, estimate])
    ).toEqual([
      [1000, { kind: "fallback", reason: "incompatible-context" }],
      [1000, { kind: "fallback", reason: "incompatible-context" }],
      [1000, { kind: "fallback", reason: "unusable-observation" }],
      [1000, { kind: "fallback", reason: "unusable-observation" }],
    ]);
    const unknown = await planNodeCheckPartitions(inventory, full, { partitions: 1, observations });
    expect(unknown.partitions[0].files.every(({ estimate }) => estimate.kind === "fallback")).toBe(
      true
    );
    const otherEnvironment = await digestNodeCheckPartitionTimingContext(inventory, {
      ...timingContext,
      environmentDigest: hash("h"),
    });
    expect(otherEnvironment).not.toBe(contextDigest);
  });

  it("rejects incomplete, unknown, repeated or empty input and excess counts", async () => {
    for (const files of [[], ["a.js", "A.js"], ["a.js", "missing.js"]])
      await expect(
        planNodeCheckPartitions(inventory, { ...selected, files }, { partitions: 1 })
      ).rejects.toThrow();
    await expect(
      planNodeCheckPartitions({ ...inventory, files: [] }, full, { partitions: 1 })
    ).rejects.toThrow(/empty/);
    await expect(
      decodeNodeCheckPartitionPlan({
        ...(await planNodeCheckPartitions(inventory, full, { partitions: 1 })),
        inventory: { ...inventory, complete: false },
      })
    ).rejects.toThrow(/complete/);
    for (const partitions of [0, 5, 17, 1.5])
      await expect(planNodeCheckPartitions(inventory, full, { partitions })).rejects.toThrow(
        /Partition count/
      );
    const invalid = await planNodeCheckPartitions(inventory, full, { partitions: 2 });
    invalid.partitions[1].files[0].path = invalid.partitions[0].files[0].path;
    await expect(decodeNodeCheckPartitionPlan(invalid)).rejects.toThrow(/Duplicate/);
    const drift = await planNodeCheckPartitions(inventory, full, { partitions: 2 });
    drift.inventory.source.treeSha = "f".repeat(40);
    await expect(decodeNodeCheckPartitionPlan(drift)).rejects.toThrow(/identity/);
  });
});

describe("partition coverage", () => {
  it("requires a matching successful terminal record for each partition and file", async () => {
    const plan = await planNodeCheckPartitions(inventory, full, { partitions: 2 });
    const evidence = await Promise.all(
      plan.partitions.map(async ({ id, files }): Promise<NodeCheckPartitionEvidence> => ({
        id,
        inventoryDigest: plan.inventoryDigest,
        requestDigest: await digestNodeCheckFileRequest(inventory.planDigest, {
          ...selected,
          files: files.map(({ path }) => path),
        }),
        process: { status: "exited", exitCode: 0, signal: null, outputComplete: false },
        execution: {
          complete: true,
          files: files.map(({ path }) => ({ path, state: "passed", durationMs: null })),
        },
      }))
    );
    expect(await verifyNodeCheckPartitionCoverage(plan, [...evidence].reverse())).toBe(true);
    expect(await verifyNodeCheckPartitionCoverage(plan, evidence.slice(1))).toBe(false);
    expect(await verifyNodeCheckPartitionCoverage(plan, [...evidence, evidence[0]])).toBe(false);
    expect(await verifyNodeCheckPartitionCoverage(plan, [evidence[0], evidence[0]])).toBe(false);
    const [first, second] = evidence;
    const record = first.execution!;
    for (const changed of [
      { ...first, requestDigest: second.requestDigest },
      { ...first, inventoryDigest: null },
      { ...first, execution: null },
      { ...first, execution: { ...record, complete: false } },
      { ...first, execution: { ...record, files: [record.files[0], record.files[0]] } },
      { ...first, execution: second.execution },
      {
        ...first,
        execution: {
          ...record,
          files: [{ ...record.files[0], state: "failed" }, ...record.files.slice(1)],
        },
      },
      { ...first, process: { ...first.process, exitCode: 1 } },
      { ...first, process: { ...first.process, status: "cancelled" } },
    ])
      expect(await verifyNodeCheckPartitionCoverage(plan, [changed, second])).toBe(false);
  });
});
