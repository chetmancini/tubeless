# Tubeless website

Human docs site plus agent entrypoints. **Not part of the npm package.**

Source of truth for long-form docs remains `../docs/*.md`. This project renders
those files and adds the landing, start, and agents pages.

## Local

```sh
cd website
bun ci
bun run dev
```

From the package root: `make website`.

## Update content

| Change | Edit |
| --- | --- |
| Concepts, CLI, recipes, agent rules | `../docs/*.md` then rebuild |
| Landing copy | `src/pages/index.astro` |
| Package version and engines | `../package.json` via `src/lib/package.ts` |
| Route catalog | `src/lib/docs.ts` (`DOC_NAV`; static paths and doc nav) |
| Rendered-link check | `scripts/check-built-links.mjs` (runs after `astro build`) |
| CLI tapes | `src/data/tapes.ts` (used on Start) |
| Studio screenshot | `public/studio.png` (recapture from `tubeless ui`) |
| Markdown downloads and full text | `src/pages/docs/[slug].md.ts`, `src/pages/llms-full.txt.ts`; generated from `DOC_NAV` and `../docs/*.md` |
| Agent URL table | `src/pages/agents.astro`, `src/pages/llms.txt.ts` |
| Visual system | `src/styles/global.css` |
| Logo and social card | `../docs/assets/logo.svg` and `../docs/assets/social.svg`; rasterize social to `public/og.png` |

Refresh captured CLI tapes by running the workbench against `examples/` and
replacing the strings in `src/data/tapes.ts`.

## Deploy

The GitHub repo already uses **GitHub Actions** as the Pages source.
`.github/workflows/pages.yml` is the deploy job: it builds `website/` on
`main` and uploads `website/dist`.

- Site: `https://chetmancini.github.io/tubeless`
- Package `make check` does not include this project

Every documentation page links to its `.md` counterpart. `/llms.txt` lists all
Markdown URLs; `/llms-full.txt` bundles the same build’s docs with the agent guide
first. Links in Markdown are absolute, so downloaded context remains navigable.
These routes use the same documentation catalog as the human navigation.

## Agent readiness and hosting boundaries

The build checks `llms.txt` against the [published file-list format](https://llmstxt.org/),
checks homepage [SoftwareApplication](https://schema.org/SoftwareApplication) JSON-LD,
and verifies the [sitemap](https://www.sitemaps.org/protocol.html) covers every human
page except the noindex 404. Every documentation page advertises its Markdown
alternate in the HTML head. The existing 404 design includes a short Markdown
recovery block, also downloadable at `/tubeless/404.md`. That download is a normal
static file (200); unknown paths must still return 404 from the host.

GitHub Pages serves static files. Astro endpoint headers are build-time metadata;
adding `Vary` to a static endpoint does not configure Pages responses.
The site therefore **does not implement Accept negotiation**. For
[acceptmarkdown.com compliance](https://acceptmarkdown.com/), choose a host or edge
layer that can serve HTML and Markdown from the same URL, honor media ranges and
quality values (including `q=0`), return 406 for unsupported types, and add
`Vary: Accept` to both variants while preserving `Accept-Encoding`. Test both cache
orders, GET and HEAD, and unknown paths before claiming compliance. A true
`text/markdown` 404 response also needs that layer. Do not replace unknown paths
with the homepage or add a client-side redirect.

Before deployment, resolve the public domain configuration. On 2026-09-12 the
configured `https://chetmancini.github.io/tubeless/` redirected to
`http://chetmancini.com/tubeless/`; HTTPS on the custom domain failed certificate
validation. Confirm the intended domain and fix Pages HTTPS/domain settings before
changing `astro.config.ts`, canonical URLs, sitemap URLs, or package metadata.
The project-path `robots.txt` is not the host-wide robots policy: the owner of
`/robots.txt` must advertise this sitemap there, or submit the sitemap through a
verified search-console property. Search rankings cannot be guaranteed by code;
use Tubeless as the product identity and Chet Mancini as its author consistently.

After publishing, check every sitemap URL, `llms.txt`, `llms-full.txt`,
`api-report.json`, every `docs/*.md`, `404.md`, and an arbitrary nonexistent path.
Compare response bodies with `dist/` and inspect redirect destinations, status,
Content-Type, and Vary. Repeat with `Accept: text/markdown`; the Pages limitation
must remain reported until hosting changes. A local build is not live deployment
verification.
