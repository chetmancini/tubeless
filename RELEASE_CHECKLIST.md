# Release checklist

Merging to `main` does not publish. Cut a release with `make release`. CI
publishes the matching `v*` tag to npm via trusted publishing
(`.github/workflows/publish.yml`, GitHub Environment `npm`). Do not
`npm publish` from a laptop and do not store an `NPM_TOKEN`. Keep
`"private": true` in git; the verify job deletes that field before packing, and
the publish job publishes the packed tarball without running project code.

Release jobs build and announce the exact commit selected by the version tag. To
retry a failed publication, rerun its original workflow. A fresh manual dispatch
from `main` can reuse an existing tag only when that tag still points to the
selected commit. Never move an existing release tag.

## Gates

Run on the release candidate before cutting a tag:

```sh
make check
make website-build
```

`make check` covers tests, declaration and type checks, the generated API check,
and packed-consumer verification. All are credential-free.

Paid agent evaluations are opt-in and never run in CI. With an authorized key in
`OPENAI_API_KEY`, run `bun run eval:agent` and `bun run eval:agent -- --codemode`,
and keep the JSON report with the candidate's evidence, including failed attempts.
A failed task is a finding even when the final edited file is correct.

## Public names

These names are the pre-1.0 contract. A pull request that changes one carries the
`breaking` label and a one-line migration note so the release notes list it under
"Breaking Changes"; removed exports are labelled automatically.

- **Package and binary:** `tubeless`; the bin path is an implementation detail.
- **Export paths:** `tubeless`, `tubeless/agent`, `tubeless/agent/openai`,
  `tubeless/agent/anthropic`, `tubeless/agent/mcp`, `tubeless/agent/node`,
  `tubeless/cli`, `tubeless/batch`, `tubeless/node`, `tubeless/rate-limit`,
  `tubeless/retry`, `tubeless/testing`, `tubeless/tracing`, `tubeless/project`,
  `tubeless/cloudflare`, `tubeless/cloudflare/cache`. `tubeless/cloudflare` loads
  only in workerd; `tubeless/cloudflare/cache` loads in Node. Studio and trace
  storage stay internal.
- **Error codes:** `TUBELESS_*` on `PipelineErrorCode`.
- **CLI exit codes:** `0` to `7` (success, usage, load, definition, validation,
  planning, execution, cancellation).
- **Storage:** `.tubeless/runs.sqlite` is the default Studio and CLI store path.
- **Other:** `Symbol.for("tubeless/pipeline-command")` is a cross-instance marker
  consumers should not set; `RUN_MODEL_VERSION` is `2`.

Version 2 and 3 trace events and NDJSON recordings remain a durable compatibility
boundary: saved recordings stay readable even though concrete exporter entrypoints
were removed.

## Studio

Studio is a local process, not an authenticated network service; `tubeless ui`
defaults to `127.0.0.1`. See [SECURITY.md](./SECURITY.md) and
[docs/studio.md](./docs/studio.md).
