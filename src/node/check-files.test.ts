import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { CHECK_REPORT_LIMITS } from "../utilities/check-report.js";
import { prepareCheckReport, readCheckReportFile } from "./check-files.js";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "check-files-"));
  roots.push(root);
  await mkdir(join(root, ".tubeless-reports"));
  return root;
}
describe("bounded native report reads", () => {
  it("distinguishes missing, oversized and regular files and clears stale output", async () => {
    const root = await fixture(),
      path = ".tubeless-reports/test.json";
    expect(await readCheckReportFile(root, path)).toEqual({ result: { state: "missing" } });
    await writeFile(join(root, path), "x".repeat(CHECK_REPORT_LIMITS.inputBytes + 1));
    expect(await readCheckReportFile(root, path)).toEqual({ result: { state: "oversized" } });
    await writeFile(join(root, path), "{");
    expect(await readCheckReportFile(root, path)).toEqual({ content: "{" });
    await prepareCheckReport(root, path);
    expect(await readCheckReportFile(root, path)).toEqual({ result: { state: "missing" } });
  });
  it("rejects traversal, leaf and directory symlinks, and nonregular files", async () => {
    const root = await fixture(),
      other = await fixture();
    await writeFile(join(other, "private.json"), "private");
    await symlink(join(other, "private.json"), join(root, ".tubeless-reports/link.json"));
    expect(await readCheckReportFile(root, "../private.json")).toEqual({
      result: { state: "malformed" },
    });
    expect(await readCheckReportFile(root, ".tubeless-reports/link.json")).toEqual({
      result: { state: "malformed" },
    });
    await expect(prepareCheckReport(root, ".tubeless-reports/link.json")).rejects.toThrow();
    await mkdir(join(root, ".tubeless-reports/directory.json"));
    expect(await readCheckReportFile(root, ".tubeless-reports/directory.json")).toEqual({
      result: { state: "malformed" },
    });
    await rm(join(root, ".tubeless-reports"), { recursive: true });
    await symlink(other, join(root, ".tubeless-reports"));
    expect(await readCheckReportFile(root, ".tubeless-reports/private.json")).toEqual({
      result: { state: "malformed" },
    });
    await expect(prepareCheckReport(root, ".tubeless-reports/test.json")).rejects.toThrow();
  });
});
