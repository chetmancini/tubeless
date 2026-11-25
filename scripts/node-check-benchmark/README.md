# Portable Node check benchmark

The O7 harness runs the supported Node 24, Bun 1.4.4 and Vitest 5.1.0 check locally or through the existing authenticated Tubeless Cloud CLI. Schedule trials serially and give each campaign its own directory under `logs/`, which Git ignores.

## Workload

The fixture-only [benchmark branch](https://github.com/chetmancini/tubeless/tree/benchmark/node-check-v1) contains the five files from [the portable Node fixture](../fixtures/node-check). Configure the Cloud pipeline to use this branch so both pinned commits are reachable. Treat the branch as an immutable fixture.

| Variant           | Git commit                                 | Git tree                                   |
| ----------------- | ------------------------------------------ | ------------------------------------------ |
| Pass              | `115e87716d640e313e4481ac442a1096a7d0bf69` | `4fcc46d81391f63b1c8be22b2db5f8855c5095f7` |
| Assertion failure | `d49bf983f9b36d5987ed9dd0f87636ef01f9c158` | `a5fad0c320f808b3991870301c91e24134b5bcf2` |

The second revision changes only `app.js` from `42` to `41`. Both have lockfile digest `o6aigou_MMjFfEGoQYWUPbCeo0pHl3K73p-sP5qJkvo` and resolved plan digest `sPrELDQ3XiH-aOApNno0cgz96krMppsK4_iavG71y70` (SHA-256, unpadded base64url). Both run the same dependency-ordered commands with concurrency one.

1. `bun install --frozen-lockfile`
2. `bun run --silent types`, which invokes `node --check app.js`
3. `node node_modules/vitest/vitest.mjs run --reporter=json --outputFile=.tubeless-reports/vitest.json --includeTaskLocation`

## Run and recover

Run these commands from the Tubeless checkout with Git, Node 24 and Bun 1.4.4 on PATH.

```sh
bun install --frozen-lockfile
bun run build
mkdir -p logs/node-check-benchmark/demonstration
benchmark=scripts/node-check-benchmark/benchmark.ts
campaign=logs/node-check-benchmark/demonstration
bun --no-env-file "$benchmark" local "$campaign/pass-01" pass
bun --no-env-file "$benchmark" local "$campaign/fail-01" assertion-failure
bun --no-env-file "$benchmark" summarize "$campaign" > "$campaign/summary.json"
```

Exercise client timeout accounting with `bun --no-env-file "$benchmark" local "$campaign/timeout-01" pass --timeout-ms 1`. This trial exits `2` and records `timeout` with an unknown execution outcome if the deadline fires during preparation.

For Cloud, use one explicitly secretless portable Node check pipeline, approved for this GitHub repository and branch. Inject a workspace automation bearer as `TUBELESS_TOKEN` with `run` and `read` access to that pipeline. Use a new trial directory for each deliberate submission.

```sh
bun --no-env-file "$benchmark" cloud "$campaign/cloud-pass-01" pass \
  --workspace "$TUBELESS_WORKSPACE" --pipeline "$TUBELESS_PIPELINE" --host "$TUBELESS_HOST"
bun --no-env-file "$benchmark" cloud "$campaign/cloud-fail-01" assertion-failure \
  --workspace "$TUBELESS_WORKSPACE" --pipeline "$TUBELESS_PIPELINE" --host "$TUBELESS_HOST"
```

The harness verifies the automation principal, records the intent, then invokes `cloud run --detach --json --source '{"kind":"main","commit":"…"}' --idempotency-key …`. It checkpoints the returned run ID before `cloud follow --poll --json` and performs a separate `cloud inspect --json` after the terminal observation. Polling usually checks every two seconds. The timeout defaults to 25 minutes and can be lowered with `--timeout-ms`. Exit `0` means the observed outcome matched the selected variant, including the controlled failure. Exit `2` means the outcome differed or observation was incomplete. Exit `1` indicates an invocation or ledger error.

- If a run ID was recorded, use `bun --no-env-file "$benchmark" resume "$campaign/cloud-pass-01"` to follow and inspect that exact run. Use the same command to reread late cleanup observations.
- If admission is uncertain and no run ID was recorded, use `bun --no-env-file "$benchmark" replay "$campaign/cloud-pass-01"` within one hour of the original attempt. The harness requires the same authenticated principal, host, workspace, pipeline, source and key. Check that run retention is intact before replay. Cloud expires a run's admission receipt with its run. After the replay window closes or if retention was disrupted, reconcile with the Cloud operator before submitting again.
- Keep the original trial directory even if a run fails, a client stops or a deadline expires. A deadline or Ctrl-C stops local observation of a Cloud run. Following the recorded ID never submits or cancels it. Each recovery invocation creates its own sample within the same trial. If the driver was forcibly stopped and left an empty `.active` directory, verify the original process is gone before removing that lock with `rmdir`.

## Experimental conditions

| Condition           | Source and dependencies                                                                                                                                                                                                      | Cache and environment                                                                                                                                                                                                                                                                                                                                                   |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fresh-local-v1`    | Each attempt fetches the pinned commit into an empty temporary Git checkout, verifies the commit, tree, materialized blobs, lock and plan, then removes Git metadata. Installation starts with no `node_modules` or reports. | Fresh home, temp and explicit empty Bun package cache. Git fetch uses the local Git authentication configuration. Recipe commands receive an allowlisted environment with the host PATH and the public registry default. Checked files and temporary directories are removed after execution. Host OS page cache, DNS, registry/CDN and network state are uncontrolled. |
| `cloud-portable-v1` | Cloud verifies and materializes the same pinned source as an archive in an isolated guest and runs the same frozen install and gates. Pipeline secrets are empty.                                                            | The pilot applies Cloud's public npm tarball policy and admitted image and resource limits. Archive reuse, provider image and infrastructure cache reuse, and cache state outside the guest are unknown per sample.                                                                                                                                                     |

Local runs use the host OS, filesystems, CPU and network. Cloud uses the recorded image, guest limits and registry interception. Node patch versions, Tubeless recipe versions, hardware, dependency binaries selected by platform, and filesystem and network costs can differ. A fresh checkout and empty local Bun cache describe filesystem preparation only.

## Raw sample v1

Each invocation writes one `*.sample.json` checkpoint in the logical trial directory before execution. The script replaces that file atomically as the invocation advances. The initial pending record survives a process loss once written. Recovery never overwrites a previous invocation file.

- `workload` binds the fixture ID, variant, GitHub repository, commit, tree, lockfile and plan. `mode`, `condition`, and `operation` identify the experimental conditions and whether the invocation starts, resumes or replays a trial. `startedAt` is a UTC label and replay guard.
- `client` records OS, architecture, CPU model, available logical CPUs and memory. `tools` records the driver versions and local executable Node and Bun versions. Cloud executable versions remain unknown. C7 toolchain values describe the admitted image catalog.
- `attemptId` identifies the logical trial, `invocationId` each local driver invocation, and `execution.runId` the pipeline run. For Cloud, `target` carries the non-secret host, workspace, pipeline, automation principal ID and idempotency key. `execution` records the image digest, source verification and normalized outcome. The expected assertion requires the original complete Vitest report and nonzero test exit.
- `observation` records the last completed or in-progress driver stage and state. A client deadline is a timeout in `observation.state`. A proven recipe or supervisor timeout is a `timed-out` execution outcome. A killed process can leave the observation pending. Absent outcomes are `unknown`.
- `observation.terminalMs` is measured on one driver monotonic clock. Local time starts before temp directory preparation and ends when the recipe returns. Cloud time starts after principal verification, immediately before submission and its checkpoint, and ends when the client decodes the terminal follow response. It includes CLI startup, network and polling delay. Separate inspection, cleanup and cross-process recovery are outside this interval. `admissionMs` uses the same Cloud start and ends when the admission receipt is decoded. `localPreparationMs` covers tool probes, source verification and plan validation. `localRecipeMs` covers recipe execution and report collection.
- `hostedMeasurements` is the optional authorized C7 v1 run inspection projection. It carries nullable identity and resource capacity, named phase durations with producer provenance and observed or derived kind, independent cleanup states and the producer's outcome. The harness checks non-null source, lock, plan and image identities against the same retained run. Missing fields or entire older projections stay unknown. The harness retains only the allowlisted sample fields. It saves no token, raw CLI output, remote logs, stderr, signed URLs or diagnostic payloads.

All timing fields use milliseconds. Cloud phase bounds and producer clocks belong to C7. Guest preparation includes startup and extraction, execution includes installation, completion overlaps both, and cleanup may arrive after terminal status. Provider startup and usage remain unknown in v1. Interpret each duration independently. The harness never subtracts a server timestamp from a client clock or sums phases.

## Summaries and qualification

`summarize` reads the ledger recursively, validates v1 and rejects duplicate invocation or start IDs. It counts every invocation and logical trial, and reports observation states, outcomes and exclusion reasons per group. Groups key on workload, condition, client context, tool versions, timeout, Cloud target, image and available resource and catalog identity. Only fresh, verified starts with the outcome expected for that variant enter distributions. Replays, resumed observations, timeouts, unexpected failures and fixture observations remain visible in counts. A controlled assertion failure is eligible for the assertion-failure group.

Each distribution reports known count, unknown count, minimum, median and maximum. The median is the middle value after sorting, or the mean of the two middle values for an even count. Cloud phases are evaluated independently by phase, producer and kind. Phase coverage counts available observations even when an entire phase has no distribution. There are no tail percentile estimates. Re-run the summary command against the same directory to regenerate it without executing the workload.

```sh
bun run test:run scripts/node-check-benchmark/benchmark.test.ts
make check
make website-build
```

The test replays sanitized native admissions and terminal inspections [captured from Cloud's Miniflare integration suite](../fixtures/node-check-benchmark/c7-miniflare.json) through the real Tubeless CLI and the harness adapter. Cloud commit `8f219a87cd546667462096116ae242b4cc33aa7b` generated those responses with `TUBELESS_CAPTURE_HOSTED_FIXTURES=1 npm run test:integration -- --node-check`. The fixture uses a simulated supervisor and synthetic repository and workspace, with one shared source commit and main and PR selectors. Its timings provide contract test data only.

The two local variants and a forced local observation timeout were exercised. Cloud's companion C7 disposable proof exercised both pinned revisions on Cloudflare and validated the producer projection. Full hosted CLI qualification still requires an approved pilot connection, a scoped application bearer and a bounded campaign ledger. A live campaign should record and reconcile exact run IDs and cleanup outcomes before interpreting distributions. Cloud owns provider measurement and accounting.
