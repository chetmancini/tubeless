import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { APIRoute } from "astro";

const reportPath = join(dirname(fileURLToPath(import.meta.url)), "../../../docs/api-report.json");

export const GET: APIRoute = () =>
  new Response(readFileSync(reportPath), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=300",
    },
  });
