import { readFileSync } from "node:fs";
import { expect, vi } from "vitest";

export async function waitForFileContent(
  path: string,
  predicate: (rendered: string) => boolean,
  timeout = 2_000
): Promise<string> {
  let rendered = "";
  await vi.waitFor(
    () => {
      rendered = readFileSync(path, "utf8");
      expect(predicate(rendered)).toBe(true);
    },
    { interval: 25, timeout }
  );
  return rendered;
}
