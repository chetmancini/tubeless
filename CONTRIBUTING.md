# Contributing

Pull requests are accepted for now. Tubeless will stay a small-maintainer
project: a merged PR does not come with commit access, and I am not looking
for a large set of regular contributors.

If a change is large or touches the public API, open an issue first.

## Prerequisites

- Bun 1.3.14 or later
- Node.js 22.6 or later
- GNU Make

## Working on the package

```sh
make install
make check
```

`make check` is the same gate CI runs. It bootstraps the package, then uses the
root [`tubeless.project.ts`](./tubeless.project.ts) project to run the remaining
checks as a concurrent Tubeless pipeline and record `logs/check.ndjson`.
`make help` lists the rest. `make install` runs `bun ci`.

Before changing usage or public behavior, read
[`docs/agent-guide.md`](./docs/agent-guide.md) and the repository-local
[`tubeless` skill](./skills/tubeless/SKILL.md). Do not edit
`docs/api-reference.md` or `docs/api-report.json` by hand; after an intentional
public-surface change, run `bun run api:generate`. Keep examples on public
package imports. Pull requests that change the report get a job summary of
added and removed entrypoints and symbols; `api:check` only proves the report
was regenerated.

### Website

The public site lives in [`website/`](./website/) and is not part of the npm
package. Local development:

```sh
cd website && bun ci && bun run dev
```

See [`website/README.md`](./website/README.md). `make check` does not build the
site; use `make website` or `make website-build` for that.

## Support

- Bug reports and documentation fixes: open a GitHub issue.
- Large or public-API changes: open an issue first.
- Vulnerabilities: report privately via [`SECURITY.md`](./SECURITY.md).
- No SLA; this is a small-maintainer project.

## Security

Report vulnerabilities privately. See [`SECURITY.md`](./SECURITY.md).

## License

Contributions are accepted under the MIT License in [`LICENSE`](./LICENSE).
