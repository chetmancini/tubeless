import { describe, expect, it } from "vitest";
import { PartialEnrichmentPipeline } from "../../examples/fan-out-partial-results.js";

const log = { log() {}, warn() {}, error() {} };

describe("partial fan-out example", () => {
  it("keeps successful items and reports the failed ones", async () => {
    const result = await PartialEnrichmentPipeline.run(
      { emails: ["ada@example.com", "no-domain", "lin@example.org"] },
      {},
      { cwd: "/tmp", log }
    );
    expect(result.status).toBe("completed");
    expect(result.value).toEqual({
      domains: ["example.com", "example.org"],
      failed: [{ index: 1, message: expect.stringContaining('No domain in "no-domain"') }],
    });
  });
});
