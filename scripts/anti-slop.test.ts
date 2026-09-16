import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const oxlint = join(packageRoot, "node_modules", ".bin", "oxlint");
const config = join(packageRoot, "tools", "oxlint", "anti-slop", "test-config.json");
const fixtures = join(packageRoot, "scripts", "fixtures", "anti-slop");

function lintFixture(name: string) {
  const result = spawnSync(oxlint, ["--config", config, join(fixtures, name)], {
    cwd: packageRoot,
    encoding: "utf8",
  });
  return { ...result, output: `${result.stdout}${result.stderr}` };
}

describe("retained anti-slop rules", () => {
  it.each(["valid-chained-type-assertions.ts", "valid-safety-comment.ts"])(
    "accepts %s",
    (fixture) => {
      const result = lintFixture(fixture);
      expect(result.status, result.output).toBe(0);
    }
  );

  it.each([
    ["invalid-chained-type-assertions.ts", "no-chained-type-assertions"],
    ["invalid-safety-comment.ts", "require-safety-comment-for-type-assertion"],
  ])("rejects %s with %s", (fixture, rule) => {
    const result = lintFixture(fixture);
    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain(rule);
  });
});
