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

## Cutting a release

Merging to `main` does not publish. Land the `package.json` `version` bump
first (keep `private: true`). The tag name must be `v` plus that version.
The draft names the bump: **patch**, **minor**, **major**, or
**prerelease** (and whether it is a 0.x minor).

Notes start generated: bump type, commits since the last version tag, plus
GitHub's pull-request notes (`.github/release.yml`). Refine that draft,
then tag.

```sh
make release-notes
make release
```

`make release` opens the draft in `$EDITOR`. The first line looks like
`tubeless 0.1.1 (patch)`. Save to accept or rewrite. `EDIT=0` ships the
generated notes as-is. `NOTES='...'` or `NOTES_FILE=notes.md` skip
generation. `DRY=1`, `PUSH=0`, `WATCH=0`, and `SKIP_CHECK=1` are
optional.

Without a checkout: Actions → **publish** → **Run workflow** on `main`.
Leave notes empty to auto-generate (including the bump label) and cut
the tag. Fill in notes to override. Empty notes also retry a version
whose tag already exists.

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
