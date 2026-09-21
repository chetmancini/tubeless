# Release checklist

Merging to `main` does not publish. Cut a release with `make release`. CI
publishes the matching `v*` tag to npm via trusted publishing
(`.github/workflows/publish.yml`, GitHub Environment `npm`). Do not
`npm publish` from a laptop. Do not store
an `NPM_TOKEN`. Keep `"private": true` in git; the publish job deletes that
field immediately before `npm publish`.

## Public names

These names are the pre-1.0 contract. Treat a change as breaking.

| Kind               | Stable name                                                                                                                                                        | Notes                                                                                                               |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| Package and binary | `tubeless`                                                                                                                                                         | Bin path `./dist/workbench/workbench-bin.js` is an implementation detail.                                           |
| Export paths       | `tubeless`, `tubeless/cli`, `tubeless/batch`, `tubeless/node`, `tubeless/rate-limit`, `tubeless/retry`, `tubeless/testing`, `tubeless/tracing`, `tubeless/project` | CLI owns terminal commands; project owns catalogs. Each API has one entrypoint. Studio and storage remain internal. |
| Error codes        | `TUBELESS_*` on `PipelineErrorCode`                                                                                                                                | Prefix and current spellings stay.                                                                                  |
| CLI exit behavior  | Codes `0`–`7`                                                                                                                                                      | Success, usage, load, definition, validation, planning, execution, cancellation.                                    |
| Storage            | `.tubeless/runs.sqlite`                                                                                                                                            | Default Studio/CLI store path.                                                                                      |
| Runtime symbols    | `Symbol.for("tubeless/pipeline-command")`                                                                                                                          | Cross-instance marker. Consumers should not set it.                                                                 |
| Other constants    | `RUN_MODEL_VERSION` (`2`)                                                                                                                                          | Stored-run version.                                                                                                 |

Version 2 trace events and NDJSON recordings remain a durable compatibility
boundary. Removing the concrete JSON and OpenTelemetry exporter entrypoints
does not remove support for existing saved recordings.

`TUBELESS_VERSION`, `TUBELESS_LIMIT`, `TUBELESS_NAMES`, and
`TUBELESS_CORE_PUBLIC_API_SMOKE_ENV` appear only in tests. They are not package
environment variables.

## Studio

The studio is a local process, not an authenticated network service.
`tubeless ui` defaults to `127.0.0.1`. See [SECURITY.md](./SECURITY.md) and
[docs/studio.md](./docs/studio.md).

## Remaining public work

- [x] Explain why the project is called Tubeless, what problem it solves,
      its maturity, and how it compares with task runners and workflow
      engines (plan 002).
- [x] Make the README/CLI/getting-started on-ramp work from a clone and a
      fresh app (plan 003).
- [x] Make examples copy-paste teachers, not compile probes (plan 004).
- [x] Add issue templates and CONTRIBUTING prerequisites (plan 004).
- [x] Add API compatibility review so `docs/api-report.json` diffs are
      explicit on pull requests.
- [x] Add dependency and workflow maintenance (Dependabot or Renovate) for
      SHA-pinned Actions and pinned devDependencies.
- [x] Add npm provenance and runtime badges now that CI and npm exist.
