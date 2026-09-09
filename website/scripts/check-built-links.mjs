import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SITE_BASE = "/tubeless";
const ORIGIN = "https://built.invalid";

export function checkBuiltLinks(outputRoot) {
  const root = resolve(outputRoot);
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new Error(`Built output not found: ${root}`);
  }

  const errors = [];
  for (const file of listHtmlFiles(root)) {
    const source = pagePathFromFile(root, file);
    const html = readFileSync(file, "utf8");
    for (const target of extractAnchorHrefs(html)) {
      const result = resolveLocalTarget(target, source, root);
      if (result.ignored) continue;
      if (!result.exists) {
        errors.push({
          source,
          target,
          message: `Broken local link on ${source}: ${target}`,
        });
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

export function runCheck(outputRoot, write = (line) => console.error(line)) {
  const result = checkBuiltLinks(outputRoot);
  for (const error of result.errors) write(error.message);
  return result.ok ? 0 : 1;
}

function listHtmlFiles(root) {
  const files = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(path);
      else if (entry.isFile() && entry.name.endsWith(".html")) files.push(path);
    }
  }
  return files.sort();
}

function pagePathFromFile(root, file) {
  const rel = relative(root, file).split(sep).join("/");
  if (rel === "index.html") return SITE_BASE;
  if (rel.endsWith("/index.html")) return `${SITE_BASE}/${rel.slice(0, -"/index.html".length)}`;
  if (rel.endsWith(".html")) return `${SITE_BASE}/${rel.slice(0, -".html".length)}`;
  return `${SITE_BASE}/${rel}`;
}

function extractAnchorHrefs(html) {
  const hrefs = [];
  const pattern = /<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  for (const match of html.matchAll(pattern)) {
    hrefs.push(decodeHtml(match[1] ?? match[2] ?? match[3] ?? ""));
  }
  return hrefs;
}

function decodeHtml(value) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function resolveLocalTarget(target, source, root) {
  const href = target.trim();
  if (!href || href.startsWith("#")) return { ignored: true };
  if (/^(?:https?:|mailto:|tel:)/i.test(href) || href.startsWith("//")) {
    return { ignored: true };
  }

  let url;
  try {
    url = new URL(href, `${ORIGIN}${source}`);
  } catch {
    return { exists: false };
  }
  if (url.origin !== ORIGIN) return { ignored: true };

  const pathname = normalizePathname(url.pathname);
  if (pathname === undefined) return { exists: false };

  const relativePath = stripSiteBase(pathname);
  if (relativePath === undefined) return { exists: false };

  let decoded;
  try {
    decoded = decodeURIComponent(relativePath);
  } catch {
    return { exists: false };
  }

  const candidate = decoded === "" ? root : resolve(root, decoded);
  if (!isInside(root, candidate)) return { exists: false };
  return { exists: outputExists(candidate) };
}

function normalizePathname(pathname) {
  if (pathname === SITE_BASE || pathname === `${SITE_BASE}/`) return SITE_BASE;
  if (pathname.endsWith("/") && pathname.length > 1) return pathname.slice(0, -1);
  return pathname;
}

function stripSiteBase(pathname) {
  if (pathname === SITE_BASE) return "";
  if (pathname.startsWith(`${SITE_BASE}/`)) return pathname.slice(SITE_BASE.length + 1);
  return undefined;
}

function outputExists(candidate) {
  if (existsSync(candidate)) {
    const info = statSync(candidate);
    if (info.isFile()) return true;
    if (info.isDirectory() && existsSync(join(candidate, "index.html"))) return true;
  }
  if (fileExists(`${candidate}.html`)) return true;
  return fileExists(join(candidate, "index.html"));
}

function fileExists(path) {
  return existsSync(path) && statSync(path).isFile();
}

function isInside(root, target) {
  const parent = resolve(root);
  const child = resolve(target);
  return child === parent || child.startsWith(`${parent}${sep}`);
}

const isMain =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const outputRoot = resolve(
    process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), "../dist")
  );
  process.exitCode = runCheck(outputRoot);
}
