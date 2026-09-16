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
[`docs/agent-guide.md`](./docs/agent-guide.md) and the repository-local
[`tubeless` skill](./skills/tubeless/SKILL.md). Do not edit
`docs/api-reference.md` or `docs/api-report.json` by hand; after an intentional
public-surface change, run `bun run api:generate`. Keep examples on public
package imports.

## Cutting a release

Merging to `main` does not publish. `make release` bumps `package.json`
(keep `private: true`), runs `make check`, commits the version, tags `v`
plus that version, and pushes `main` then the tag. GitHub creates release
notes from merged pull requests using `.github/release.yml`.

```sh
make release                 # patch
make release BUMP=minor
make release BUMP=major
make release BUMP=prerelease
make release VERSION=0.2.0
```

Version increments use `npm version --no-git-tag-version`. Default bump is
patch. `BUMP=prerelease` uses the `rc` prerelease identifier; use `VERSION=`
for an exact version. Both release paths reject a version older than the latest
version tag. If `make check` fails after the version is written, restore
`package.json` before retrying.

Without a checkout: Actions → **publish** → **Run workflow** on `main`.
That path does not bump `package.json`; land the version first (or use
`make release`). It tags the checked-in version and creates the GitHub Release
with generated notes.

Do not `npm publish` from a laptop. Do not attach npm tarballs to GitHub
Releases; npm is the artifact.

Prereleases use a semver prerelease version (`0.2.0-rc.1` / tag `v0.2.0-rc.1`).
GitHub marks them as prerelease; npm publishes to the `next` dist-tag so
`latest` does not move.

Optional pull request labels for the generated "What's Changed" section:
`breaking`, `enhancement`, `bug`, `documentation`, `dependencies`, and
`ignore-for-release`.

Rollback a bad version with `npm deprecate tubeless@version "reason"` and
`npm dist-tag add tubeless@<previous> latest`. Prefer that over
`npm unpublish`. Edit the GitHub Release with a yanked warning.

## Security

Report vulnerabilities privately. See [`SECURITY.md`](./SECURITY.md).

## License

Contributions are accepted under the MIT License in [`LICENSE`](./LICENSE).
