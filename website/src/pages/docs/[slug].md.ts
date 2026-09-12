import type { APIRoute } from "astro";
import { DOC_NAV, loadMarkdown } from "../../lib/docs";

export function getStaticPaths() {
  return DOC_NAV.map(({ slug }) => ({ params: { slug } }));
}

export const GET: APIRoute = ({ params }) => new Response(loadMarkdown(params.slug!), {
  headers: { "content-type": "text/markdown; charset=utf-8" },
});
