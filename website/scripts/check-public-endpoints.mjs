import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../dist");

export function endpointFiles(files) {
  return files.filter((file) => file !== "404.html" && /\.(html|md|txt|json|xml)$/.test(file))
    .map((file) => ({ file, path: file === "index.html" ? "" : file.replace(/\/index\.html$/, "") }));
}

export function responseProblems({ status, type, vary, body }, { file, expected, markdown = false, missing = false }) {
  const problems = [];
  if (status !== (missing ? 404 : 200)) problems.push(`HTTP ${status}, expected ${missing ? 404 : 200}`);
  const mediaType = type.split(";")[0].trim().toLowerCase();
  const types = markdown || file?.endsWith(".md") ? ["text/markdown"]
    : file?.endsWith(".html") ? ["text/html"]
    : file?.endsWith(".json") ? ["application/json"]
    : file?.endsWith(".xml") ? ["application/xml", "text/xml"] : ["text/plain"];
  if (!types.includes(mediaType)) problems.push(`Content-Type ${type || "missing"}, expected ${types.join(" or ")}`);
  if (markdown && !vary.toLowerCase().split(",").map((v) => v.trim()).includes("accept")) problems.push("Vary missing Accept");
  if (expected !== undefined && body !== expected) problems.push("Body differs from current build");
  if (missing && !["llms.txt", "sitemap.xml"].every((link) => body.includes(link))) problems.push("Missing 404 recovery links");
  return problems;
}

export async function checkPublicEndpoints(base) {
  const entries = endpointFiles(readdirSync(root, { recursive: true }));
  const results = [];
  // Serial requests keep the audit gentle on the public origin.
  for (const { file, path } of entries) {
    const expected = readFileSync(join(root, file), "utf8");
    for (const accept of ["*/*", "text/markdown"]) {
      const negotiation = file.endsWith(".html") && accept === "text/markdown";
      await probe(path, accept, { file, expected: negotiation ? undefined : expected, markdown: negotiation });
    }
  }
  for (const accept of ["*/*", "text/markdown"]) {
    await probe("__agent-readiness-nonexistent__/nested", accept, { file: "404.html", missing: true, markdown: accept === "text/markdown" });
  }
  return results;

  async function probe(path, accept, expectation) {
    const url = new URL(path, base.endsWith("/") ? base : `${base}/`).href;
    const redirects = [];
    try {
      let target = url;
      let response;
      for (let hop = 0; hop < 6; hop++) {
        response = await fetch(target, { headers: { Accept: accept }, redirect: "manual", signal: AbortSignal.timeout(15000) });
        if (![301, 302, 303, 307, 308].includes(response.status)) break;
        const location = response.headers.get("location");
        if (!location) break;
        const next = new URL(location, target).href;
        redirects.push({ status: response.status, from: target, to: next });
        await response.body?.cancel();
        target = next;
      }
      const observed = {
        status: response.status, type: response.headers.get("content-type") ?? "",
        vary: response.headers.get("vary") ?? "", body: await response.text(),
      };
      const problems = responseProblems(observed, expectation);
      if (redirects.some(({ from, to }) => from.startsWith("https:") && to.startsWith("http:"))) problems.push("HTTPS redirect downgrades to HTTP");
      results.push({ url, accept, redirects, status: observed.status, type: observed.type, vary: observed.vary, problems });
    } catch (error) {
      results.push({ url, accept, redirects, problems: [String(error), String(error.cause ?? "")] });
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const results = await checkPublicEndpoints(process.argv[2] ?? "https://chetmancini.github.io/tubeless/");
  console.log(JSON.stringify(results, null, 2));
  process.exitCode = results.some(({ problems }) => problems.length) ? 1 : 0;
}
