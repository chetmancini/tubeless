import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { EnrichmentPipeline } from "../examples/resumable-enrichment";

describe("resumable enrichment example", () => {
  it("does not create or flush its checkpoint during a dry run", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tubeless-enrichment-example-"));
    const checkpointPath = path.join(directory, "checkpoint.json");

    try {
      const result = await EnrichmentPipeline.run({
        checkpointPath,
        dryRun: true,
        items: ["alpha", "beta"],
      });

      expect(result.status).toBe("completed");
      expect(result.steps).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "load-pending-items", status: "completed" }),
          expect.objectContaining({
            id: "enrich-items",
            reason: "dry-run",
            status: "skipped",
          }),
        ])
      );
      expect(fs.existsSync(checkpointPath)).toBe(false);
    } finally {
      fs.rmSync(directory, { force: true, recursive: true });
    }
  });
});
