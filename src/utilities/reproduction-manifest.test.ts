import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  decodeReproductionManifest,
  digestNodeCheckPlan,
  parseReproductionManifest,
  REPRODUCTION_MANIFEST_MAX_BYTES,
  type ReproductionManifest,
} from "./reproduction-manifest.js";

const fixture = readFileSync(
  new URL("../../fixtures/reproduction/node-check-failure-v1.json", import.meta.url)
);
const manifest = (): ReproductionManifest => JSON.parse(fixture.toString("utf8"));

describe("Node check reproduction manifest", () => {
  it("accepts the paired fixture and hashes Cloud's canonical plan independently of key order", async () => {
    const input = manifest();
    const { plan, digest } = input.nodeCheck;
    expect(await parseReproductionManifest(fixture)).toEqual(input);
    expect(
      await digestNodeCheckPlan({
        commands: plan.commands,
        maxConcurrency: plan.maxConcurrency,
        lockfile: plan.lockfile,
        toolchain: plan.toolchain,
        recipe: plan.recipe,
        version: plan.version,
      })
    ).toBe(digest);
  });

  it("rejects unsupported versions, malformed UTF-8 and byte overflow before decoding the plan", async () => {
    const unsupported = readFileSync(
      new URL("../../fixtures/reproduction/node-check-unsupported-v2.json", import.meta.url)
    );
    await expect(parseReproductionManifest(unsupported)).rejects.toThrow(
      "Unsupported reproduction manifest version"
    );
    await expect(parseReproductionManifest(Uint8Array.of(0xff))).rejects.toThrow(
      "valid UTF-8 JSON"
    );
    await expect(
      parseReproductionManifest("é".repeat(REPRODUCTION_MANIFEST_MAX_BYTES))
    ).rejects.toThrow("exceeds 64 KiB");
  });

  it.each([
    [
      "plan digest mismatch",
      (input: ReproductionManifest) => {
        input.nodeCheck.digest = "A".repeat(43);
      },
    ],
    [
      "Unsupported reproduction manifest Node check plan",
      (input: ReproductionManifest) => {
        input.nodeCheck.plan.commands[0].argv = ["arbitrary"];
      },
    ],
    [
      "source commit",
      (input: ReproductionManifest) => {
        input.source.commit = "main";
      },
    ],
    [
      "source tree SHA",
      (input: ReproductionManifest) => {
        input.source.treeSha = "HEAD";
      },
    ],
    [
      "lockfile digest",
      (input: ReproductionManifest) => {
        input.source.lockfile.digest = "0".repeat(64);
      },
    ],
    [
      "GitHub repository name",
      (input: ReproductionManifest) => {
        input.repository.fullName = "https://github.com/org/project";
      },
    ],
    [
      "image digest",
      (input: ReproductionManifest) => {
        input.runtime.imageDigest = "latest";
      },
    ],
    [
      "diagnostic reference",
      (input: ReproductionManifest) => {
        input.diagnostics![0].artifact = "../test.check-report.json";
      },
    ],
    [
      "manifest fields",
      (input: ReproductionManifest) => {
        Object.assign(input, { env: {} });
      },
    ],
  ] as const)("rejects %s", async (message, mutate) => {
    const input = manifest();
    mutate(input);
    await expect(decodeReproductionManifest(input)).rejects.toThrow(message);
  });
});
