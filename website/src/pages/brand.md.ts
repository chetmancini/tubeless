import type { APIRoute } from "astro";
import { absUrl } from "../lib/paths";

export const GET: APIRoute = () => new Response(`# Tubeless brand

Logo files for referring to Tubeless in articles, integrations, and community projects.

- [Wordmark for light backgrounds](${absUrl("wordmark.svg")})
- [Wordmark for dark backgrounds](${absUrl("wordmark-inverse.svg")})
- [Square app icon](${absUrl("logo.svg")})
`, { headers: { "content-type": "text/markdown; charset=utf-8" } });
