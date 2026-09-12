import type { APIRoute } from "astro";
import { DOC_NAV, loadMarkdown } from "../lib/docs";
import { absUrl } from "../lib/paths";
import { PACKAGE } from "../lib/package";

export const GET: APIRoute = () => new Response([
  `# Tubeless documentation\n\nVersion: ${PACKAGE.version}\nIndex: ${absUrl("llms.txt")}\n\nRead the agent guide before writing pipelines. Documentation below is generated from the same sources as the human site.`,
  ...[...DOC_NAV].sort((a, b) => Number(b.slug === "agent-guide") - Number(a.slug === "agent-guide"))
    .map(({ slug }) => `Source: ${absUrl(`docs/${slug}.md`)}\n\n${loadMarkdown(slug)}`),
].join("\n\n---\n\n"), {
  headers: { "content-type": "text/plain; charset=utf-8" },
});
