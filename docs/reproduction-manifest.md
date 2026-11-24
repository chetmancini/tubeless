# Reproduce a Cloud Node check locally

Save the reproduction manifest for an eligible Cloud run as a local JSON file.
On Linux or macOS, put Git, Node 24 and Bun 1.4.4 on PATH, then run:

```sh
tubeless cloud reproduce --execute reproduction.json
```

The `--execute` flag authorizes the recorded repository's package scripts,
dependency installation and tests to run with your local permissions. Use it
only for revisions you trust. Downloading a manifest or parsing it with
`tubeless/reproduction-manifest` performs no source fetch or execution.

The command fetches one full commit SHA from the recorded GitHub repository
into a temporary checkout. Git uses your configured credential helpers or SSH
agent. If the revision is unavailable to your Git account, the command fails.
It verifies the commit, Git tree, checked-out file contents, `bun.lock` digest
and resolved Node check plan before launching the recipe. It removes Git
metadata after verifying the checkout, so the recipe sees the same tracked
files as a Cloud source archive. The temporary directory is removed on
completion, failure or handled cancellation.

Recipe subprocesses get a fresh home and temporary directory and use the local
tools on PATH. They run with `CI=true`, `CF_SEND_TELEMETRY=false` and `NO_COLOR=1`.
Git and check subprocesses receive no Cloud environment credentials. The command leaves your working files alone. The Cloud image
digest appears in the result as original-run metadata. The reproduction runs
as a host process, with local filesystem and network permissions. Choose
source and dependencies you trust accordingly. The local OS, architecture and
exact tool versions appear in the result, along with any differences from
recorded versions. The plan enforces Node major 24 and Bun 1.4.4.

Standard output is one JSON result with the original run and source identity,
local runtime, structured pipeline result, native command outcomes and
normalized Vitest reports. Exit codes are `0` for a pass, `6` for a failed
check, `7` for interruption, `4` for invalid input or failed prerequisites,
and `1` for incorrect CLI usage. Raw Git and check process logs are omitted.
Normalized reports contain repository-produced diagnostic text.

V1 covers the [portable Node check recipe](./node-check-recipe.md) for secretless
single-package checks using the default public npm registry. Cloud environment
settings, caches, private registries and other recipe types are outside this
contract.

## Cloud producer handoff

Export a manifest for an authorized, retained, terminal portable Node check
with secretless execution and complete source, plan and image identity. Admit
the download using the original run's read authorization and retention checks.
Build an explicit projection from the bound run and repository job. Exclude
runs with source or plan data containing credentials. Treat exact version
metadata as unknown when the bound run evidence is unavailable.

All fields are required except `diagnostics`. Additional fields are rejected.
The entire UTF-8 JSON file is capped at 64 KiB, including whitespace.

| V1 field                                          | Retained Cloud source and encoding                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `version`                                         | Integer `1`.                                                                                                                                                                                                                                                                                                                                                                                                       |
| `run.id`, `run.pipelineId`                        | The original run's IDs.                                                                                                                                                                                                                                                                                                                                                                                            |
| `repository.id`, `repository.fullName`            | `sourceIdentity.repository.id` and the GitHub `owner/repo` name. The ID identifies the Cloud record. Local Git fetches by name and verifies the content identities below.                                                                                                                                                                                                                                          |
| `source.commit`, `source.treeSha`                 | `sourceIdentity.commit` and `sourceIdentity.treeSha`. Each is 40 lowercase hex characters. Use the archived source commit, including a merge revision if that was the actual source.                                                                                                                                                                                                                               |
| `source.lockfile`                                 | `sourceIdentity.lockfile` with literal `path: "bun.lock"` and `digest` as SHA-256 of the lockfile bytes, in unpadded base64url.                                                                                                                                                                                                                                                                                    |
| `nodeCheck.plan`, `nodeCheck.digest`              | Retained `repositoryJob.nodeCheck.plan` and `digest`, also on CLI run detail. Keep the original values. The digest is SHA-256 in unpadded base64url over UTF-8 JSON with recursively sorted object keys and preserved array order, matching Cloud's `runnerDigest(stableJson(plan))`.                                                                                                                              |
| `runtime.imageDigest`                             | The job's `recipe.imageDigest`, also `nodeCheck.imageDigest` on CLI run detail. Use `sha256:` followed by 64 lowercase hex characters.                                                                                                                                                                                                                                                                             |
| `runtime.node`, `runtime.bun`, `runtime.tubeless` | Exact version strings from the bound supervisor observation's `toolchain.node`, `toolchain.bun` and `toolchain.runtime`, when those values carry the corresponding version metadata. Use `null` for unknowns. The CLI run detail for a portable check does not currently expose this observation. The plan's required toolchain and today's image catalog provide no evidence of an original run's exact versions. |
| `diagnostics`                                     | Up to two optional `{ stepId, artifact }` references to retained Vitest snapshots. Each artifact is exactly `<stepId>.check-report.json` for a distinct admitted Vitest step. Labels are scoped to the original run.                                                                                                                                                                                               |

IDs are 1–128 ASCII characters starting with an alphanumeric character and
continuing with alphanumerics, `.`, `_`, `:` or `-`. Exact version fields use
three numeric components and an optional release suffix. The manifest carries
the captured image identity and any retained version metadata. Toolchain
requirements come from `nodeCheck.plan.toolchain`.

Keep download authorization and local execution separate. The manifest carries
no installation IDs, Git URLs, tokens, environment fields, logs, raw diagnostic
payloads or signed artifact URLs. The Cloud UI can display the command above
after the file is saved. Keep that command explicit and use the suggested
filename when rendering it.

### Public API and validation

Import `ReproductionManifest`, `REPRODUCTION_MANIFEST_MAX_BYTES`,
`decodeReproductionManifest(value)`, `parseReproductionManifest(textOrBytes)`
and `digestNodeCheckPlan(plan)` from `tubeless/reproduction-manifest`. The
entrypoint uses Web APIs and works in a Cloud Worker. The async decoders throw
on invalid data and verify the retained plan digest. Validate the projected JSON
before serving it. Use the byte parser when the serialized payload is available
so the wire-size limit is checked as well. Keep the retained digest as the
comparison value.

Use the paired JSON files under `fixtures/reproduction/` in the OSS repository
for producer and consumer tests. `node-check-failure-v1.json` carries the portable
Node fixture plan and a deterministic Git commit where `answer` is 41.
`node-check-unsupported-v2.json` must be rejected. Both use synthetic identities.
The OSS CLI test creates the exact Git commit from `scripts/fixtures/node-check/`,
moves `main` forward, and serves the pinned revision over a test Git transport.
It expects the failed `test` check and its normalized `app.test.js` diagnostic.

With Node 24 and Bun 1.4.4 on PATH, verify the contract and CLI locally:

```sh
bun run test:run src/utilities/reproduction-manifest.test.ts src/workbench/workbench-reproduce.test.ts
make check
make website-build
```

Wait for an OSS release that publishes both `tubeless/reproduction-manifest`
and `tubeless cloud reproduce`. Verify both against the npm tarball, then pin that
exact version in Cloud and run the paired fixture tests against the installed
package. Run Cloud's `make check` and `node scripts/integration.mjs --node-check`
with the producer and retained-run authorization tests in place. Keep the
download and generated command gated until those checks pass.
