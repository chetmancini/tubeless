# Public release checklist

The initial extraction came from
`bible-search/packages/pipes-core` at commit
`d629f3c4859a6145ca3f06c594799e69844d577b` on 2026-08-26.

The npm registry returned `E404` for the unscoped `tubeless` name on that date.
That is evidence that no public package was visible, not a reservation of the
name; recheck immediately before the first publish.

## Release blockers

- [x] Choose the first public semantic version (`0.1.0` is the conservative
      choice while the API is still being proven) and update `version`.
      Keep `private: true` until the first registry publish.
- [x] Add complete npm metadata: `repository`, `homepage`, `bugs`, `keywords`,
      author/maintainers, supported runtime `engines`, and explicit public
      `publishConfig`.
- [x] Decide and document the support contract: ESM-only imports, minimum Node
      version for library entrypoints, Bun requirement for the `tubeless` CLI,
      and supported operating systems.
- [ ] Audit the public API for names that should be stable at launch, including
      export paths, the `tubeless` binary, `TUBELESS_*` error codes,
      `TUBELESS_WORKBENCH_EXIT_CODE`, `.tubeless` storage, studio headers, and
      runtime symbol keys.
- [ ] Perform a legal and public-source scrub: confirm MIT ownership and
      copyright, third-party notices, contributor attribution/history, and that
      no internal URLs, credentials, customer data, or private repository
      assumptions remain.
- [ ] Review the local studio threat model. Confirm loopback binding remains the
      safe default, document the risk of non-loopback binding, and test the
      launch/clear-history request guards.
- [x] Add CI on the declared Node/Bun support matrix. It must run the complete
      `make check` gate and fail on stale generated API artifacts.
- [x] Validate the exact tarball in clean consumers: inspect `npm pack --dry-run`,
      check size and contents, install the tarball, import every export path,
      run the executable, and confirm the executable bit and Bun shebang.
- [x] Configure npm Trusted Publishing from a GitHub-hosted Actions runner with
      least-privilege `contents: read` and `id-token: write` permissions on
      `.github/workflows/publish.yml`. Do not store an `NPM_TOKEN`.
- [ ] Operator: enable 2FA on the npm account (auth-and-writes), then register
      GitHub Actions as the trusted publisher for `tubeless`: - Organization or user: `chetmancini` - Repository: `tubeless` - Workflow filename: `publish.yml` (filename only) - Environment: `npm` - Allowed action: `npm publish`
      Recheck `npm view tubeless` immediately before the first tag. If the name
      is taken, STOP. Create the empty GitHub Environment `npm` (Settings →
      Environments) if Actions has not created it yet.
- [ ] Operator: first publish is `git tag v0.1.0` on the commit you intend, then
      `git push origin v0.1.0`. Do not `npm publish` from a laptop. After it
      succeeds, set package publishing to trusted-publisher-only / disallow
      tokens if the npm UI offers that.
- [ ] Define the release trigger and rollback process: protected version tags,
      GitHub Releases, prerelease dist-tags, deprecation guidance, and who can
      publish or yank/deprecate a broken version.

## Documentation and project quality

- [x] Add installation examples for npm, pnpm, yarn, and Bun, plus one minimal
      library example that runs on the declared minimum Node version.
- [ ] Explain why the project is called Tubeless, what problem it solves, its
      maturity level, and how it compares with task runners and workflow
      engines without overpromising stability.
- [x] Decide whether `docs`, `examples`, and `evals` should all ship in the npm
      tarball. Keep only artifacts that improve the installed-package
      experience, then update the pack verifier to enforce that policy.
- [x] Add `CONTRIBUTING.md`. Pull requests are accepted for now; the
      maintainer set stays small.
- [x] Add `SECURITY.md` with private GitHub vulnerability reporting.
- [ ] Add a code of conduct, support policy, issue/PR templates, and a
      changelog or release-notes convention.
- [ ] Add API compatibility review to pull requests by making changes to the
      generated API report explicit and reviewable.
- [ ] Add runnable examples to CI and smoke-test the README commands from a
      clean checkout.
- [ ] Add dependency and workflow maintenance (Dependabot or Renovate), minimal
      GitHub Actions permissions, pinned action policy, and a secret-scanning
      check appropriate for a public repository.
- [ ] Add package badges only after their targets exist: CI, npm version,
      license, provenance, and supported runtimes.

## Extraction follow-through

- [x] Copy the package-owned source, tests, docs, examples, evaluation fixtures,
      tooling, manifest, lockfile, and license into the standalone repository.
- [x] Rebrand package imports, CLI commands, local paths, Studio UI, protocol
      headers, runtime markers, tests, fixtures, and public error namespaces to
      `tubeless`.
- [ ] Decide whether to preserve the original package's Git history with a
      filtered-history import or keep the source commit recorded above as the
      extraction provenance.
- [ ] Publish Tubeless before changing Bible Search consumers. Then replace the
      workspace dependency with a pinned registry range, run Bible Search's
      full native checks, and remove the internal package only after consumer
      parity is verified.
- [ ] Search the Bible Search repository for imports, CLI invocations, generated
      artifacts, CI path filters, documentation, and release scripts that still
      refer to `@pipes/core`, `pipes`, or `packages/pipes-core`.
