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
