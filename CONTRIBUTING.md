# Contributing

Pull requests are accepted for now. Tubeless will stay a small-maintainer
project: a merged PR does not come with commit access, and I am not looking
for a large set of regular contributors.

If a change is large or touches the public API, open an issue first.

## Working on the package

```sh
make install
make check
```

`make check` is the same gate CI runs. `make help` lists the rest.

Before changing usage or public behavior, read
[`docs/agent-guide.md`](./docs/agent-guide.md). Do not edit
`docs/api-reference.md` or `docs/api-report.json` by hand; after an intentional
public-surface change, run `bun run api:generate`. Keep examples on public
package imports.

## Security

Report vulnerabilities privately. See [`SECURITY.md`](./SECURITY.md).

## License

Contributions are accepted under the MIT License in [`LICENSE`](./LICENSE).
