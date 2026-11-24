# Contributing

Pull requests are accepted for now. Tubeless is a small-maintainer project: a
merged PR does not come with commit access, and there is no SLA. Open an issue
before a large or public-API change. Report vulnerabilities privately via
[`SECURITY.md`](./SECURITY.md).

## Prerequisites

- Bun 1.3.14 or later
- Node.js 22.18 or later
- GNU Make

## Working on the package

```sh
make install
make check
```

`make check` is the gate CI runs: it bootstraps the package, then runs the
remaining checks as a concurrent Tubeless pipeline defined in
[`scripts/check-pipeline.ts`](./scripts/check-pipeline.ts) and records
`logs/check.ndjson`. `make help` lists the rest.

Builds and type checks use the pinned `tsrs` compiler in its default mode; keep
fast mode disabled. Packed-consumer checks compile a fixture for every public entry
point with the pinned and oldest supported TypeScript (`typescript-floor`) under
`NodeNext` and `Bundler` resolution.

### Fast loops

Tests and type checks resolve `tubeless` from `dist/`, so they need a build after
source changes; `make test` and `make typecheck` run one for you. With `dist/`
current, `make test-run` and `make typecheck-run` skip the build. `make lint` never
rebuilds. `make watch` rebuilds `src/` on change, regenerates the Studio client,
and re-runs tests; `make studio-check` fails when the served bundle does not match
its sources.

Oxlint runs the Landmines rules configured in `.oxlintrc.json`. Tests should wait
for observable events or use fake timers for timing assertions. Keep assertions
unconditional and put expected values in the `test.each` case table. Reduce
per-file allowances as conditional assertions, parameter branches, and timeout
overrides are removed. The Vitest diagnostics fixture deliberately exercises
spec-file discovery and retries.

Split source files by responsibility before they exceed 500 lines. Existing
longer files are capped at their recorded size. Group related modules in a
directory once three siblings would share a filename prefix. Update or remove an
existing `no-prefix-cluster` allowance when its module count goes down.

## Public API and docs

Before changing usage or public behavior, read [`docs/agent-guide.md`](./docs/agent-guide.md)
and the repository-local [`tubeless` skill](./skills/tubeless/SKILL.md). Module
ownership and dependency rules are in [`src/README.md`](./src/README.md).

Do not edit `docs/api-reference.md` or `docs/api-report.json` by hand; after an
intentional public-surface change run `bun run api:generate`. Keep examples on
public package imports. A changed surface hash with unchanged names means a public
declaration changed. A pull request that removes a public export is labelled
`breaking` automatically; apply the label by hand for an incompatible change to an
existing export. Either way, add a one-line migration note to the pull request
description.

## Website

The public site lives in [`website/`](./website/) and is not part of the npm
package. Run it with `cd website && bun ci && bun run dev`; see
[`website/README.md`](./website/README.md). `make check` does not build it; use
`make website-build`.

## License

Contributions are accepted under the MIT License in [`LICENSE`](./LICENSE).
