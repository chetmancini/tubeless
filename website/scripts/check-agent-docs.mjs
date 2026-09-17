import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../dist");
const read = (path) => readFileSync(join(root, path), "utf8");
const index = read("llms.txt");
const bundle = read("llms-full.txt");
const documentSchema = JSON.parse(read("schemas/pipeline-document-v1.schema.json"));
assert.equal(documentSchema.$id, "https://tubeless.io/schemas/pipeline-document-v1.schema.json");
assert.equal(read("pipeline-document.schema.json"), read("schemas/pipeline-document-v1.schema.json"));
assert.ok(index.includes(documentSchema.$id), "Agents must be able to discover the document schema");
assert.deepEqual(documentSchema, JSON.parse(readFileSync(join(root, "../../docs/pipeline-document.schema.json"), "utf8")), "Website schema must match the packaged source");
assert.equal(read("CNAME").trim(), "tubeless.io", "Pages artifact must preserve the custom domain");
assert.ok(index.includes("https://tubeless.io/developers.md"));
const pages = readdirSync(join(root, "docs"))
  .filter((name) => existsSync(join(root, "docs", name, "index.html")));
assert.ok(pages.length > 0, "Built documentation pages must exist");
for (const slug of pages) {
  const path = `docs/${slug}.md`;
  const markdown = read(path);
  assert.match(markdown, /^# /, `${path} must contain a document title`);
  assert.ok(index.includes(`https://tubeless.io/${path}`), `${path} must be discoverable in llms.txt`);
  assert.ok(bundle.includes(markdown), `${path} must be included in full documentation`);
  assert.ok(read(`docs/${slug}/index.html`).includes(`/${path}`), `${slug} must link to Markdown`);
  for (const [, target] of markdown.matchAll(/\]\(([^)]+)\)/g)) {
    if (target.startsWith("#")) continue;
    assert.match(target, /^(https?:|mailto:)/, `${path} has a relative link: ${target}`);
    const url = new URL(target);
    if (url.origin !== "https://tubeless.io") continue;
    const local = decodeURIComponent(url.pathname.slice(1));
    assert.ok(existsSync(join(root, local)), `${path} has a missing local target: ${target}`);
  }
}
assert.ok(bundle.indexOf("Source: https://tubeless.io/docs/agent-guide.md") < bundle.indexOf("Source: https://tubeless.io/docs/getting-started.md"), "Full documentation must lead with the agent guide");
console.log(`Verified ${pages.length} Markdown documents, discovery links, and full documentation bundle.`);

// Validate the llms.txt file-list grammar, not just the presence of keywords.
assert.match(index, /^# tubeless\n\n> .+\n/);
assert.match(index, /## When to use Tubeless\n/);
assert.match(index, /not a hosted execution API/);
assert.match(index, /tubeless plan <registered-id>/);
for (const section of index.split(/^## /m).slice(1)) {
  const [heading, ...lines] = section.split("\n");
  const entries = lines.filter((line) => line.trim());
  assert.ok(entries.length > 0, `${heading} must contain resources`);
  for (const entry of entries) {
    assert.match(entry, /^- \[[^\]]+\]\(https:\/\/[^)]+\)(?:: .+)?$/, `${heading}: invalid llms.txt file entry`);
  }
}

const homepage = read("index.html");
assert.match(homepage, /<title>Tubeless — Typed pipelines for Node\.js<\/title>/);
assert.match(homepage, /name="application-name" content="Tubeless"/);
assert.match(homepage, /property="og:site_name" content="Tubeless"/);
assert.match(homepage, /<link rel="alternate" type="text\/markdown" href="\/index.md"/);
assert.match(read("index.md"), /^# Tubeless\n/);
assert.match(read("index.md"), /## When to use Tubeless\n/);
assert.ok(index.includes("https://tubeless.io/index.md"));
assert.match(homepage, /href="\/developers"/);
for (const [, target] of read("index.md").matchAll(/\]\(([^)]+)\)/g)) {
  const url = new URL(target);
  if (url.origin === "https://tubeless.io") {
    assert.ok(existsSync(join(root, url.pathname.slice(1))), `Missing overview target: ${target}`);
  }
}
const jsonld = [...homepage.matchAll(/<script\b[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)];
assert.equal(jsonld.length, 1);
const software = JSON.parse(jsonld[0][1]);
assert.equal(software["@context"], "https://schema.org");
assert.equal(software["@type"], "SoftwareApplication");
assert.equal(software.name, "Tubeless");
assert.equal(software.alternateName, "Tubeless TypeScript Pipelines");
assert.equal(software.url, "https://tubeless.io/");
assert.equal(software.author.name, "Chet Mancini");
assert.equal(software.author["@type"], "Person");
assert.ok(software.description.length > 0);
assert.ok(software.softwareVersion.length > 0);
assert.deepEqual(software.keywords, ["TypeScript pipelines", "Node.js workflows", "typed ETL"]);
assert.deepEqual(software.sameAs, ["https://github.com/chetmancini/tubeless"]);
assert.match(homepage, /name="description" content="Tubeless by Chet Mancini:/);

const developers = read("developers/index.html");
assert.match(developers, /<title>Developer Resources · Tubeless<\/title>/);
assert.match(developers, /<h1 class="page-title">Tubeless developer resources<\/h1>/);
assert.match(developers, /href="\/docs\/api-reference"/);
assert.match(developers, /type="text\/markdown" href="\/developers\.md"/);
assert.match(read("developers.md"), /^# Tubeless developer resources\n/);

const sitemap = read("sitemap.xml");
assert.match(sitemap, /^<\?xml version="1.0" encoding="UTF-8"\?>\n<urlset xmlns="http:\/\/www.sitemaps.org\/schemas\/sitemap\/0.9">/);
assert.match(sitemap, /<\/urlset>\s*$/);
const locations = [...sitemap.matchAll(/<url><loc>([^<]+)<\/loc><\/url>/g)].map((match) => match[1]);
const humanPages = readdirSync(root, { recursive: true })
  .filter((file) => file.endsWith(".html") && file !== "404.html")
  .map((file) => file === "index.html" ? "" : file.replace(/\/index\.html$/, ""));
assert.deepEqual(locations.sort(), humanPages.map((path) => `https://tubeless.io/${path}`).sort());
assert.equal(new Set(locations).size, locations.length);
assert.match(read("robots.txt"), /Sitemap: https:\/\/tubeless.io\/sitemap.xml/);

for (const path of humanPages) {
  const html = read(path ? `${path}/index.html` : "index.html");
  assert.match(html, /<link rel="describedby" href="\/llms.txt"/);
  assert.match(html, /<link rel="sitemap" type="application\/xml" href="\/sitemap.xml"/);
  const markdown = path ? `/${path}.md` : "/index.md";
  assert.ok(html.includes(`<link rel="alternate" type="text/markdown" href="${markdown}"`), `${path || "homepage"} must advertise Markdown`);
}
for (const slug of pages) {
  const html = read(`docs/${slug}/index.html`);
  assert.ok(html.includes(`<link rel="alternate" type="text/markdown" href="/docs/${slug}.md"`));
}
const recovery = read("404.md");
assert.match(recovery, /^# 404 — Page not found\n/);
for (const path of ["llms.txt", "docs", "sitemap.xml"]) {
  assert.ok(recovery.includes(`https://tubeless.io/${path}`));
}
assert.ok(read("404.html").includes(recovery), "404 HTML must include the short Markdown recovery body");
assert.match(read("404.html"), /name="robots" content="noindex"/);
assert.match(read("404.html"), /type="text\/markdown" href="\/404.md"/);
console.log(`Verified software identity, llms.txt grammar, recovery content, and ${locations.length} sitemap pages.`);
