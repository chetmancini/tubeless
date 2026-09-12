import type { APIRoute } from "astro";
import { recoveryMarkdown } from "../lib/recovery";

// Static recovery document; the host, not this build-time response, sets 404 status.
export const GET: APIRoute = () => new Response(recoveryMarkdown(), {
  headers: { "content-type": "text/markdown; charset=utf-8" },
});
