import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { openCheckpoint } from "tubeless/node";
import { EnrichmentCommand, EnrichmentPipeline } from "../../examples/resumable-enrichment.js";

const log = { log() {}, warn() {}, error() {} };
const checkpointName = "enrichment.checkpoint.json";

function withTempDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tubeless-enrichment-example-"));
  return run(directory).finally(() => {
    fs.rmSync(directory, { force: true, recursive: true });
  });
}

describe("resumable enrichment example", () => {
  it("does not create its checkpoint during a dry run", async () => {
    await withTempDirectory(async (directory) => {
      const result = await EnrichmentCommand.run(
        ["--item", "alpha", "--item", "beta", "--dry-run"],
        { cwd: directory, log }
      );

      expect(result).toEqual({ enrichedCount: 0 });
      expect(fs.existsSync(path.join(directory, checkpointName))).toBe(false);
    });
  });

  it("resumes from recorded items and clears the checkpoint on success", async () => {
    await withTempDirectory(async (directory) => {
      const checkpointPath = path.join(directory, checkpointName);
      const seeded = openCheckpoint(checkpointPath);
      seeded.record("alpha");
      seeded.flush();

      const result = await EnrichmentCommand.run(
        ["--item", "alpha", "--item", "beta", "--resume"],
        { cwd: directory, log }
      );

      expect(result).toEqual({ enrichedCount: 1 });
      expect(fs.existsSync(checkpointPath)).toBe(false);
    });
  });

  it("runs programmatically without a checkpoint", async () => {
    const result = await EnrichmentPipeline.run({ items: ["alpha"] });

    expect(result.status).toBe("completed");
    expect(result.value).toEqual({ enrichedCount: 1 });
  });
});
