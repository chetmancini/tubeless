import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { APIRoute } from "astro";

const schemaPath = join(__REPO_ROOT__, "docs", "pipeline-document.schema.json");

export const GET: APIRoute = () => new Response(readFileSync(schemaPath), {
  headers: {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "public, max-age=300",
  },
});
