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
- [x] Audit the public API for names that should be stable at launch, including
      export paths, the `tubeless` binary, `TUBELESS_*` error codes,
      `TUBELESS_WORKBENCH_EXIT_CODE`, `.tubeless` storage, studio headers, and
      runtime symbol keys. See [Public names](#public-names).
- [x] Perform a legal and public-source scrub: confirm MIT ownership and
      copyright, third-party notices, contributor attribution/history, and that
      no internal URLs, credentials, customer data, or private repository
      assumptions remain. See [Legal and public-source scrub](#legal-and-public-source-scrub).
- [x] Review the local studio threat model. Confirm loopback binding remains the
      safe default, document the risk of non-loopback binding, and test the
      launch/clear-history request guards. See [Studio threat model](#studio-threat-model).
- [x] Add CI on the declared Node/Bun support matrix. It must run the complete
      `make check` gate and fail on stale generated API artifacts.
- [x] Validate the exact tarball in clean consumers: inspect `npm pack --dry-run`,
      check size and contents, install the tarball, import every export path,
      run the executable, and confirm the executable bit and Bun shebang.
- [x] Configure npm Trusted Publishing from a GitHub-hosted Actions runner with
      least-privilege `contents: read` and `id-token: write` permissions on
      `.github/workflows/publish.yml`. Do not store an `NPM_TOKEN`.
- [x] Operator: enable 2FA on the npm account (auth-and-writes), then register
      GitHub Actions as the trusted publisher for `tubeless`: Organization or
      user `chetmancini`, repository `tubeless`, workflow filename `publish.yml`,
      environment `npm`, allowed action `npm publish`. Rechecked that the
      unscoped name was free. The GitHub Environment `npm` already existed.
      Trusted publisher id `837d83b1-a87f-4f95-9e4a-5116be724dac`.
- [x] Operator: `tubeless@0.1.0` had to be published once from this machine so
      the trusted publisher could be attached (`npm trust` requires an existing
      package). Then tagged `v0.1.0` on `083e021` and pushed that tag. The
      tag workflow skipped republish. Set `npm access set mfa=publish`. The
      stronger npm UI toggle (require 2FA and disallow tokens) remains
      optional.
- [x] Define the release trigger and rollback process. Cut an annotated
      `vX.Y.Z` tag matching `package.json` `version` (`make release`, or
      Actions → publish → Run workflow). See CONTRIBUTING. Pushing the tag
      publishes to npm (`publish.yml`) and opens a GitHub Release
      (`github-release.yml`). The tag annotation is the changelog; GitHub
      appends generated notes (merged PRs via `.github/release.yml`).
      Prerelease tags (`vX.Y.Z-rc.N`) are GitHub prereleases and npm `next`.
      Who: repository admins. Do not `npm publish` from a laptop. Rollback:
      `npm deprecate tubeless@version "reason"` and point `latest` at the
      previous good version with `npm dist-tag add`. Prefer that over
      `npm unpublish` (72-hour window, discouraged). Edit the GitHub Release
      with a yanked warning. Optional later: a ruleset on `refs/tags/v*`.

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
- [x] Changelog / release-notes convention: GitHub Releases from annotated
      version tags, plus generated notes configured in `.github/release.yml`.
      No `CHANGELOG.md`.
- [ ] Add a code of conduct, support policy, and issue/PR templates.
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

## Public names

These names are the 0.1.0 contract. Treat a change as a breaking change.

| Kind               | Stable name                                                                                                                                                                                                                                                                                                                                       | Notes                                                                                                                                                          |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Package and binary | `tubeless`                                                                                                                                                                                                                                                                                                                                        | Bin path `./dist/workbench-bin.js` is an implementation detail.                                                                                                |
| Export paths       | `tubeless`, `tubeless/batch`, `tubeless/cli`, `tubeless/node`, `tubeless/rate-limit`, `tubeless/render`, `tubeless/reporter`, `tubeless/retry`, `tubeless/run-store`, `tubeless/run-store/sqlite`, `tubeless/run-store/ui`, `tubeless/workbench/studio`, `tubeless/testing`, `tubeless/tracing`, `tubeless/tracing/json`, `tubeless/tracing/otel` | `workbench` is the CLI family name, not leftover `pipes` branding. Keep `tubeless/workbench/studio` rather than adding a `tubeless/studio` alias before 0.1.0. |
| Error codes        | `TUBELESS_*` on `PipelineErrorCode`                                                                                                                                                                                                                                                                                                               | Prefix and current spellings stay.                                                                                                                             |
| CLI exit codes     | `TUBELESS_WORKBENCH_EXIT_CODE` from `tubeless/cli`                                                                                                                                                                                                                                                                                                | `0`–`7`: success, usage, load, definition, validation, planning, execution, cancellation.                                                                      |
| Storage            | `.tubeless/runs.sqlite`                                                                                                                                                                                                                                                                                                                           | Default studio/CLI store path.                                                                                                                                 |
| Studio headers     | `x-tubeless-studio-plan`, `x-tubeless-studio-launch`, `x-tubeless-studio-clear-history`                                                                                                                                                                                                                                                           | Local studio protocol.                                                                                                                                         |
| Runtime symbols    | `Symbol.for("tubeless/pipeline-command")`, `Symbol.for("tubeless/pipeline-studio-config/v1")`                                                                                                                                                                                                                                                     | Cross-instance markers. Consumers should not set these.                                                                                                        |
| Other constants    | `PIPELINE_FINALIZE_STEP_ID` (`__finalize__`), `RUN_MODEL_VERSION` (`1`), `PIPELINE_STUDIO_CONFIG_VERSION` (`1`)                                                                                                                                                                                                                                   | Reserved finalize id and stored-run/studio versions.                                                                                                           |

`tubeless/run-store/ui` also re-exports `PipelineRunStudioCommand`,
`PipelineRunStudioLauncher`, `PipelineRunStudioLaunchResult`,
`PipelineRunStudioLaunchRequest`, and `PipelineRunStudioHistoryMaintenance`.
The inventory generator now counts `export type { … }` blocks so those names
stay reviewable.

`TUBELESS_VERSION`, `TUBELESS_LIMIT`, `TUBELESS_NAMES`, and
`TUBELESS_CORE_PUBLIC_API_SMOKE_ENV` appear only in tests. They are not package
environment variables.

## Legal and public-source scrub

- LICENSE is MIT, Copyright (c) 2026 Chet Mancini. `package.json` author,
  repository, homepage, and bugs match that identity.
- Git history in this worktree is only Chet Mancini
  (`chet.mancini@gmail.com` / `chetmancini@gmail.com`). No third-party
  contributor attribution is owed.
- Runtime is dependency-free. DevDependencies are oxlint, oxfmt, TypeScript,
  Vitest, and `@types/node`. `StandardSchemaV1` is a local subset of the
  Standard Schema protocol, not a vendored file with a third-party copyright
  header. No NOTICE file is required.
- No credentials, tokens, customer data, or private hosts in the tree. URLs
  are public GitHub links plus local studio `http://` examples.
- `bible-search`, `@pipes/core`, and `packages/pipes-core` remain only in this
  checklist as extraction provenance and post-publish consumer follow-through.
  They are not in shipped docs, examples, or source.
- Scrubbed before publish: Bible Search domain leftovers in
  `docs/child-pipeline-composition.md` (`DbSeedSeriesPipeline`, verse
  embeddings) and test fixtures (`kjv` / `genesis` / `Bible version` /
  `verses.json`). That composition page now documents the shipped child
  adapter instead of the extraction-era design memo.

## Studio threat model

The studio is a local process, not an authenticated network service.

- `tubeless ui` defaults to `127.0.0.1`. Plan and launch are refused unless
  `--host` is `127.0.0.1`, `::1`, or `localhost` (case-insensitive).
- Clear-history is injected only on those loopback hosts. A non-loopback
  `--host` without commands is read-only; anyone who can reach the port can
  read the store, including pipeline log text.
- `startPipelineRunStudio` defaults to `127.0.0.1` but does not refuse a
  non-loopback host plus an injected launcher or history capability. That
  combination is out of scope, same as a non-loopback CLI bind the user
  enables.
- Plan, launch, and clear-history require a `Host` matching the bound
  authority, a custom `x-tubeless-studio-*` header, and `application/json`
  for plan and launch. Those are same-origin guards, not authentication.

Documented in `SECURITY.md` and `docs/studio.md`. Covered by
`src/run-store-ui.test.ts` and `src/workbench.test.ts`.
