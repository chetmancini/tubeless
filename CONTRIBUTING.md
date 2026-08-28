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

Merging to `main` does not publish. Cut an annotated version tag when you
want a release. The annotation is the changelog; GitHub appends generated
notes (merged pull requests, grouped by `.github/release.yml`).

1. Land the `package.json` `version` bump on `main`. Keep `private: true`.
2. Tag that commit. The tag name must be `v` plus that version.
3. Push the tag. That runs npm publish (`.github/workflows/publish.yml`) and
   opens a GitHub Release (`.github/workflows/github-release.yml`).

```sh
git tag -a v0.1.1 -m "$(cat <<'EOF'
Short summary of the release.

- User-facing change
- Another change
EOF
)"
git push origin v0.1.1
```

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
