import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test } from "vitest";

test("passes upstream esbuild source-map verification", async () => {
  const { stdout } = await promisify(execFile)(process.execPath, ["verify-source-map.cjs"]);
  expect(stdout).toContain("verify source map passed");
}, 100_000);
