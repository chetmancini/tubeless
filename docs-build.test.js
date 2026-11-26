import { readFile } from "node:fs/promises";
import { expect, test } from "vitest";

test("renders the upstream VitePress guide", async () => {
  const html = await readFile("docs/.vitepress/dist/index.html", "utf8");
  expect(html).toContain('id="what-is-vitepress"');
  expect(html).toContain("Static Site Generator");
});
