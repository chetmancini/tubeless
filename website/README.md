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
