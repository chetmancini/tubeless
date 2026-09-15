import type { APIRoute } from "astro";
import { loadMarkdown } from "../lib/docs";

export const GET: APIRoute = () => new Response(loadMarkdown("getting-started"), {
  headers: { "content-type": "text/markdown; charset=utf-8" },
});
