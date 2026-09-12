import type { APIRoute } from "astro";
import { DOC_NAV } from "../lib/docs";
import { absUrl } from "../lib/paths";

export const GET: APIRoute = () => {
  const paths = ["", "start", "agents", "docs", ...DOC_NAV.map(({ slug }) => `docs/${slug}`)];
  const escapeXml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
  return new Response(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${paths.map((path) => `  <url><loc>${escapeXml(absUrl(path))}</loc></url>`).join("\n")}
</urlset>
`, { headers: { "content-type": "application/xml; charset=utf-8" } });
};
