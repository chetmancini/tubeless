import { defineMdastPlugin, type MdastPluginEntry, type PluginFactoryContext } from "satteri";
import { GITHUB_BLOB } from "./paths";

type SiteHref = (path: string) => string;

const rootHref: SiteHref = (path) => `/${path.replace(/^\/+/, "")}`;

function rewriteDocTarget(target: string, siteHref: SiteHref): string {
  const angle = target.match(/^<(.*)>$/);
  const value = angle?.[1] ?? target;
  const [path, hash] = value.split("#");
  const suffix = hash ? `#${hash}` : "";
  if (!path || /^(?:https?:|mailto:)/.test(path)) return target;
  let rewritten: string | undefined;
  if (path === "./llms.txt" || path === "llms.txt") {
    rewritten = `${siteHref("llms.txt")}${suffix}`;
  } else if (path === "./api-report.json" || path === "api-report.json") {
    rewritten = `${siteHref("api-report.json")}${suffix}`;
  } else if (path === "./pipeline-document.schema.json" || path === "pipeline-document.schema.json") {
    rewritten = `${siteHref("schemas/pipeline-document-v1.schema.json")}${suffix}`;
  } else if (path.startsWith("../")) {
    rewritten = `${GITHUB_BLOB}/${path.slice(3)}${suffix}`;
  } else if (path.endsWith(".md")) {
    const slug = path.replace(/^\.\//, "").replace(/\.md$/, "");
    rewritten = slug === "README" ? `${GITHUB_BLOB}/README.md${suffix}` : `${siteHref(`docs/${slug}`)}${suffix}`;
  }
  if (!rewritten) return target;
  return angle ? `<${rewritten}>` : rewritten;
}

export function rewriteDocLinks(markdown: string, siteHref: SiteHref): string {
  const inline = markdown.replace(/\]\(([^)]+)\)/g, (full, target: string) => {
    const rewritten = rewriteDocTarget(target, siteHref);
    return rewritten === target ? full : `](${rewritten})`;
  });
  return inline.replace(/^(\s*\[[^\]\n]+\]:\s*)(<[^>\n]+>|[^\s\n]+)(.*)$/gm, (_full, prefix, target, suffix) => {
    return `${prefix}${rewriteDocTarget(target, siteHref)}${suffix}`;
  });
}

// Docs pages reference each other and repo files with relative Markdown links.
// Sätteri visits each link node once; a document that carries neither inline
// nor reference targets skips the plugin and keeps the parser's plugin-free
// fast path.
const docLinksPlugin = defineMdastPlugin({
  name: "doc-links",
  link(node, ctx) {
    ctx.setProperty(node, "url", rewriteDocTarget(node.url, rootHref));
  },
  image(node, ctx) {
    ctx.setProperty(node, "url", rewriteDocTarget(node.url, rootHref));
  },
  definition(node, ctx) {
    ctx.setProperty(node, "url", rewriteDocTarget(node.url, rootHref));
  },
});

export const docLinks: MdastPluginEntry = ({ source }: PluginFactoryContext) =>
  source.includes("](") || source.includes("]:") ? docLinksPlugin : null;

// Each docs page begins with an h1 that the Doc layout renders as the page
// title, so the article body drops it.
export const removeDocTitle = defineMdastPlugin({
  name: "remove-doc-title",
  before(root, ctx) {
    const first = root.children[0];
    if (first && first.type === "heading" && first.depth === 1) {
      ctx.removeChildAt(root, 0);
    }
  },
});
