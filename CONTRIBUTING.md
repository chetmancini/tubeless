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
The annotation is the changelog; GitHub appends generated notes (merged
pull requests, grouped by `.github/release.yml`).

From a clean `main` that matches `origin/main`:

```sh
make release NOTES='Short summary of the release.

- User-facing change
- Another change'
```

That runs `make check`, creates the annotated tag, pushes it, and watches
the Actions runs. Omit `NOTES` to write the annotation in your editor.
`NOTES_FILE=notes.md`, `DRY=1`, `PUSH=0`, `WATCH=0`, and `SKIP_CHECK=1`
are optional.

Or Actions → **publish** → **Run workflow** on `main`. Fill in notes to
cut a new tag (that run also opens the GitHub Release and publishes to
npm). Notes can be omitted when retrying a version whose tag already
exists.

```sh
git tag -a v0.1.1 -m "$(cat <<'EOF'
Short summary of the release.

- User-facing change
- Another change
EOF
)"
git push origin v0.1.1
```

is the same cut as `make release` if you want to tag by hand.

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
