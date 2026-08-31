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
| CLI tapes | `src/data/tapes.ts` (used on Start) |
| Studio screenshot | `public/studio.png` (recapture from `tubeless ui`) |
| Agent URL table | `src/pages/agents.astro`, `src/pages/llms.txt.ts` |
| Visual system | `src/styles/global.css` |

Refresh captured CLI tapes by running the workbench against `examples/` and
replacing the strings in `src/data/tapes.ts`.

## Deploy

The GitHub repo already uses **GitHub Actions** as the Pages source.
`.github/workflows/pages.yml` is the deploy job: it builds `website/` on
`main` and uploads `website/dist`.

- Site: `https://chetmancini.github.io/tubeless`
- Package `make check` does not include this project
