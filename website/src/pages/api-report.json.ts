import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { APIRoute } from "astro";

const reportPath = join(__REPO_ROOT__, "docs", "api-report.json");

export const GET: APIRoute = () =>
  new Response(readFileSync(reportPath), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=300",
    },
  });
