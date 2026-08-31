import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { marked } from "marked";
import { GITHUB_BLOB, href } from "./paths";

const docsDir = join(dirname(fileURLToPath(import.meta.url)), "../../../docs");

export type DocPage = {
  slug: string;
  title: string;
  description: string;
  html: string;
  headings: { id: string; text: string; level: number }[];
};

export const DOC_NAV = [
  { slug: "getting-started", label: "Getting started" },
  { slug: "recipes", label: "Recipes" },
  { slug: "concepts", label: "Concepts" },
  { slug: "cli", label: "CLI" },
  { slug: "studio", label: "Studio" },
  { slug: "comparison", label: "Comparison" },
  { slug: "child-pipeline-composition", label: "Child pipelines" },
  { slug: "agent-guide", label: "Agent guide" },
  { slug: "agent-evaluations", label: "Evaluations" },
  { slug: "api-reference", label: "API inventory" },
] as const;

export const DOC_SLUGS = new Set(DOC_NAV.map((item) => item.slug));

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/[`*_]/g, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

function rewriteDocLinks(markdown: string): string {
  return markdown.replace(/\]\(([^)]+)\)/g, (full, target: string) => {
    const [path, hash] = target.split("#");
    const suffix = hash ? `#${hash}` : "";
    if (!path || /^(?:https?:|mailto:)/.test(path)) return full;
    if (path === "./llms.txt" || path === "llms.txt") {
      return `](${href("llms.txt")}${suffix})`;
    }
    if (path === "./api-report.json" || path === "api-report.json") {
      return `](${href("api-report.json")}${suffix})`;
    }
    if (path.startsWith("../")) {
      return `](${GITHUB_BLOB}/${path.slice(3)}${suffix})`;
    }
    if (path.endsWith(".md")) {
      const slug = path.replace(/^\.\//, "").replace(/\.md$/, "");
      if (slug === "README") {
        return `](${GITHUB_BLOB}/README.md${suffix})`;
      }
      return `](${href(`docs/${slug}`)}${suffix})`;
    }
    return full;
  });
}

function addHeadingIds(html: string): { html: string; headings: DocPage["headings"] } {
  const headings: DocPage["headings"] = [];
  const next = html.replace(/<h([2-3])>([\s\S]*?)<\/h\1>/g, (_match, level, inner) => {
    const text = String(inner).replace(/<[^>]+>/g, "").trim();
    const id = slugify(text);
    headings.push({ id, text, level: Number(level) });
    return `<h${level} id="${id}">${inner}</h${level}>`;
  });
  return { html: next, headings };
}

export function loadDoc(slug: string): DocPage {
  const source = readFileSync(join(docsDir, `${slug}.md`), "utf8");
  const title = source.match(/^#\s+(.+)$/m)?.[1]?.replace(/`/g, "") ?? slug;
  const description =
    source
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0 && !line.startsWith("#") && !line.startsWith("|")) ?? title;
  const html = marked.parse(rewriteDocLinks(source), { async: false, gfm: true }) as string;
  const rendered = addHeadingIds(html);
  return { slug, title, description, ...rendered };
}

export function listDocs(): DocPage[] {
  return DOC_NAV.map((item) => loadDoc(item.slug));
}
