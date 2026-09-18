import { GITHUB_BLOB } from "./paths";

type MarkdownNode = {
  type?: string;
  depth?: number;
  url?: string;
  children?: MarkdownNode[];
};

type SiteHref = (path: string) => string;

const rootHref: SiteHref = (path) => `/${path.replace(/^\/+/, "")}`;

function rewriteDocTarget(target: string, siteHref: SiteHref): string {
  const [path, hash] = target.split("#");
  const suffix = hash ? `#${hash}` : "";
  if (!path || /^(?:https?:|mailto:)/.test(path)) return target;
  if (path === "./llms.txt" || path === "llms.txt") {
    return `${siteHref("llms.txt")}${suffix}`;
  }
  if (path === "./api-report.json" || path === "api-report.json") {
    return `${siteHref("api-report.json")}${suffix}`;
  }
  if (path === "./pipeline-document.schema.json" || path === "pipeline-document.schema.json") {
    return `${siteHref("schemas/pipeline-document-v1.schema.json")}${suffix}`;
  }
  if (path.startsWith("../")) {
    return `${GITHUB_BLOB}/${path.slice(3)}${suffix}`;
  }
  if (path.endsWith(".md")) {
    const slug = path.replace(/^\.\//, "").replace(/\.md$/, "");
    if (slug === "README") {
      return `${GITHUB_BLOB}/README.md${suffix}`;
    }
    return `${siteHref(`docs/${slug}`)}${suffix}`;
  }
  return target;
}

export function rewriteDocLinks(markdown: string, siteHref: SiteHref): string {
  return markdown.replace(/\]\(([^)]+)\)/g, (full, target: string) => {
    const rewritten = rewriteDocTarget(target, siteHref);
    return rewritten === target ? full : `](${rewritten})`;
  });
}

function rewriteMarkdownNode(node: MarkdownNode): void {
  if (node.url && (node.type === "link" || node.type === "image" || node.type === "definition")) {
    node.url = rewriteDocTarget(node.url, rootHref);
  }
  node.children?.forEach(rewriteMarkdownNode);
}

export default function remarkDocLinks(): (tree: MarkdownNode) => void {
  return rewriteMarkdownNode;
}

export function remarkRemoveDocTitle(): (tree: MarkdownNode) => void {
  return (tree) => {
    if (tree.children?.[0]?.type === "heading" && tree.children[0].depth === 1) {
      tree.children.shift();
    }
  };
}
