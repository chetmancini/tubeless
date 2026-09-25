import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ArtifactLineagePipeline } from "../../examples/artifact-lineage.js";
import type { PipelineTraceEvent } from "tubeless/tracing";

it("previews without writing, then records the artifacts from the executable recipe", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "tubeless-artifacts-"));
  const events: PipelineTraceEvent[] = [];
  const context = {
    cwd,
    tracing: {
      exporter: {
        export: (event: PipelineTraceEvent) => {
          events.push(event);
        },
      },
    },
  };
  try {
    await writeFile(join(cwd, "rows.txt"), " One\nTWO \n");
    const options = { source: "rows.txt", destination: "out/rows.json" };
    const preview = await ArtifactLineagePipeline.runOrThrow(options, { dryRun: true }, context);
    await expect(readFile(join(cwd, options.destination))).rejects.toMatchObject({
      code: "ENOENT",
    });
    const result = await ArtifactLineagePipeline.runOrThrow(options, {}, context);
    expect(result).toEqual(preview);
    expect(JSON.parse(await readFile(join(cwd, options.destination), "utf8"))).toEqual([
      "one",
      "two",
    ]);
    const artifacts = events.filter((event) => event.name === "step.artifact");
    expect(artifacts.map((event) => [event.payload.operation, event.payload.preview])).toEqual([
      ["read", false],
      ["write", true],
      ["read", false],
      ["write", false],
    ]);
    expect(artifacts[0].payload.artifact.checksum).toMatch(/^sha256:[a-f0-9]{64}$/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

it("identifies source bytes even when distinct invalid UTF-8 inputs decode alike", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "tubeless-artifact-bytes-"));
  const artifacts: Extract<PipelineTraceEvent, { name: "step.artifact" }>[] = [];
  const sources = [Buffer.from([0x80, 0x0a]), Buffer.from([0x81, 0x0a])];
  expect(sources[0]!.toString("utf8")).toBe(sources[1]!.toString("utf8"));
  try {
    for (const bytes of sources) {
      await writeFile(join(cwd, "rows.txt"), bytes);
      await ArtifactLineagePipeline.runOrThrow(
        { source: "rows.txt", destination: "rows.json" },
        { dryRun: true },
        {
          cwd,
          tracing: {
            exporter: {
              export(event) {
                if (event.name === "step.artifact" && event.payload.operation === "read") {
                  artifacts.push(event);
                }
              },
            },
          },
        }
      );
    }
    expect(artifacts).toHaveLength(2);
    expect(artifacts.map(({ payload }) => payload.artifact.byteSize)).toEqual([2, 2]);
    expect(artifacts.map(({ payload }) => payload.artifact.checksum)).toEqual(
      sources.map((bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`)
    );
    expect(artifacts[0]!.payload.artifact.checksum).not.toBe(
      artifacts[1]!.payload.artifact.checksum
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
