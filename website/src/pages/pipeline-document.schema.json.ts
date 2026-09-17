import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { APIRoute } from "astro";

const schemaPath = join(dirname(fileURLToPath(import.meta.url)), "../../../docs/pipeline-document.schema.json");

export const GET: APIRoute = () => new Response(readFileSync(schemaPath), {
  headers: {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "public, max-age=300",
  },
});
