# Structured check failures

The first O2/C4 slice is implemented locally. It is not a published package or
hosted rollout. OSS is `0.4.1` in this checkout; Cloud pins patched
`0.4.1`. No dependency pin or deployment is changed by this slice.

## Produce a Vitest report

Keep your existing process supervisor and test suite. Opt into Vitest 5's
[JSON reporter](https://vitest.dev/guide/reporters) for the invocation you want
to inspect:

```sh
bunx vitest run --reporter=json --outputFile=vitest.json --includeTaskLocation
```

Use `vitestCheckReport(content, options)` from `tubeless/node` after the process
closes. Pass the source `root`, actual installed `toolVersion`, pipeline/run/step
and optional attempt/source identity in `context`, and the separately observed
`process` outcome. Set `context.rawOutputArtifact` when you retain the original
JSON report. No console text is parsed. The adapter launches no processes,
installs no dependencies, changes no exit codes, and grants no authority.

The result is `{ state: "available", report }` or one of `missing`, `malformed`,
`unsupported-version`, and `oversized`. An absent input is missing; invalid or
interrupted JSON is malformed. Unsupported Vitest majors are explicit. Complete
JSON with missing tests or interrupted process observations is incomplete.

Save a successful conversion as a JSON artifact. Record it with the existing
`context.recordArtifact` after writing, keeping the body out of trace metadata.
See [artifact lineage](artifacts.md). On Cloud, upload it through the existing
run-scoped artifact capability with a filename ending in `.check-report.json`
and `application/json`. Persist the report **before** surfacing the native
nonzero exit as a step failure. The normal process outcome must still fail the
check even if the report claims every test passed.

## Version 1 contract

`CheckReport`, `CheckProcessOutcome`, `CheckTest`, `CheckFailure`, limits and
`readCheckReport` are exported from `tubeless/check-report`. The report describes one
invocation, not full repository coverage. It has:

- `version: 1`, tool name/version and caller-supplied invocation/source context;
- a native outcome independent of test claims: exited, signalled, timed-out,
  cancelled, spawn-failed or unavailable, plus nullable exit code/signal and
  output completeness;
- test file, suite ancestry, title, final outcome, available duration and location,
  and bounded failures; collection/setup failures have a separate list;
- `completeness`, `truncated` and `omittedTests`.

Test IDs encode `[relativeFile, suiteAncestry, title, duplicateOrdinal]` as JSON.
Paths use `/` relative to the supplied root. Outside-root paths and overlong
identities are rejected rather than clipped. Duplicate names carry
`ambiguous: true`; their ordinal depends on declaration order, so use file-level
selection. Parameterized titles are preserved. Vitest JSON supplies final retry
outcomes and may retain earlier failure messages; retry attempt history is
unavailable. Missing durations, locations, causes and raw references stay absent.
Failure messages/stacks are retained from structured runner data, not parsed for
source locations. `includeTaskLocation` supplies test declaration locations.

Input JSON is capped at 2 MB; normalized reports at 32 KiB and 128 tests. The
adapter favors failed tests over other outcomes under both limits, preserving
their original identities and source order among retained tests. Each
test retains four failures, with 2,000-character messages and 4,000-character
stacks. Collection failures are capped at 16. Details clipped or tests omitted
by the adapter set `truncated` and `completeness: "incomplete"`. The decoder
rejects oversized/invalid normalized reports rather than accepting partial JSON.
Unknown fields are discarded. `decodeCheckReportResult` also selects only the
fields allowed by a service envelope's state. Process outcomes are a discriminated
union; contradictory exit/signal combinations are malformed. The shared
`checkReportCompleteness` policy conservatively marks pending tests, unavailable
process outcomes and incomplete output as incomplete, even when uploaded JSON
claims completeness. Never treat absent diagnostics as a passing check.

## Cloud and CLI boundary

Cloud preserves existing `PipelineError` fields in bounded `structuredError`
step snapshots and `structuredErrors` run snapshots; legacy `error` strings stay.
Classification, source codes, stack, causes, validation issues and fan-out
details remain machine-readable. Cause chains retain four levels; all strings,
lists and individual snapshots are bounded, with `truncated: true` on loss.
Run-level errors retain eight entries and `omittedStructuredErrors` through
`projectStructuredErrors`. `structuredError` and `STRUCTURED_ERROR_LIMITS` enforce
the final 12 KB serialized limit, including JSON escapes and the loss flag.
Both native and Dynamic Worker projections preserve available run-level errors,
including finalization failures.

The native retained-run response and existing hosted MCP `get_run` include the
same `diagnostics` projection: up to two report artifacts, each with its decoder
state, plus `omitted`, derived from distinct report names in the artifact manifest. `missing` means no report was uploaded in a captured run;
`unavailable` means the stored record predates capture or only its summary is
available. Body/source identities inside a report are untrusted claims. The
enclosing run and artifact name establish authorized ownership. `nativeCommands`
contains the existing supervisor's observed command exits separately, never
exits promoted from a report. Ordinary logs remain available.

Read grants expose these bounded diagnostic contents under existing run access.
Downloading full/raw artifacts still requires `artifacts:read`. Workspace,
pipeline and retention checks apply to both API and MCP. Report uploads use the
existing storage quota and retention path. Report bodies cannot mint check
receipts or deployment evidence. CLI response validation preserves the additions
in `cloud run --json`; old services and string-only errors remain supported.

## Validation and remaining work

The real deliberately failing fixture lives under `fixtures/diagnostics/vitest`.
The checked report and framework trace fixtures in `fixtures/diagnostics` have
identical copies in Cloud. OSS tests run the fixture with the actual Vitest JSON
reporter, round-trip framework errors through the existing trace codec and
exercise machine CLI output. Cloud's `--diagnostics` Miniflare integration
uploads the paired report from a real Dynamic Worker and reads it through the
native API and hosted MCP, including authorization denial cases.

Cloud's fallback codecs are generated from the OSS sources by
`scripts/sync-diagnostics.mjs --source /path/to/tubeless`. Its unit-test gate checks
snapshot digests; `--check --source /path/to/tubeless` verifies source parity.
The pinned package does not yet export these diagnostic codecs.
This proves fixture and local consumer agreement, not released integration or
production support. Publish the OSS changes and validate a deliberate Cloud pin
upgrade before advertising the adapter as installed. Deployment is separate.
The fixed native repository supervisor does not yet collect arbitrary test report
files: wire an approved report transport into that recipe before claiming native
hosted Vitest collection. Its observed command exits are exposed already.

TypeScript/compiler adapters, richer error locations, retry attempt histories,
large-report pagination, general process capture, test selection/sharding, log
search, subscriptions and reproduction remain outside this slice.
