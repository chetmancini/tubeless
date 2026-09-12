import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../dist");
const read = (path) => readFileSync(join(root, path), "utf8");
const index = read("llms.txt");
const bundle = read("llms-full.txt");
const pages = readdirSync(join(root, "docs"))
  .filter((name) => existsSync(join(root, "docs", name, "index.html")));
assert.ok(pages.length > 0, "Built documentation pages must exist");
for (const slug of pages) {
  const path = `docs/${slug}.md`;
  const markdown = read(path);
  assert.match(markdown, /^# /, `${path} must contain a document title`);
  assert.ok(index.includes(`/tubeless/${path}`), `${path} must be discoverable in llms.txt`);
  assert.ok(bundle.includes(markdown), `${path} must be included in full documentation`);
  assert.ok(read(`docs/${slug}/index.html`).includes(`/tubeless/${path}`), `${slug} must link to Markdown`);
  for (const [, target] of markdown.matchAll(/\]\(([^)]+)\)/g)) {
    if (target.startsWith("#")) continue;
    assert.match(target, /^(https?:|mailto:)/, `${path} has a relative link: ${target}`);
    const url = new URL(target);
    if (url.origin !== "https://chetmancini.github.io" || !url.pathname.startsWith("/tubeless/")) continue;
    const local = decodeURIComponent(url.pathname.slice("/tubeless/".length));
    assert.ok(existsSync(join(root, local)), `${path} has a missing local target: ${target}`);
  }
}
assert.ok(bundle.indexOf("Source: https://chetmancini.github.io/tubeless/docs/agent-guide.md") < bundle.indexOf("Source: https://chetmancini.github.io/tubeless/docs/getting-started.md"), "Full documentation must lead with the agent guide");
console.log(`Verified ${pages.length} Markdown documents, discovery links, and full documentation bundle.`);
