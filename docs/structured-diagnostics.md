# Structured check failures

Turn a Vitest run into a bounded, machine-readable report that survives pipeline
steps, traces, and Cloud, without parsing console text or changing the check's
native exit code.

## Produce a Vitest report

Keep your existing test suite and process supervisor. Opt into Vitest 5's
[JSON reporter](https://vitest.dev/guide/reporters) for the invocation you want to
inspect:

```sh
bunx vitest run --reporter=json --outputFile=vitest.json --includeTaskLocation
```

After the process closes, call `vitestCheckReport(content, options)` from
`tubeless/node`. Pass:

- `root`: the source root; test paths are reported relative to it
- `toolVersion`: the installed Vitest version (only major 5 is supported)
- `context`: pipeline, run, step, and optional attempt and source identity; set
  `context.rawOutputArtifact` if you keep the original JSON
- `process`: the separately observed process outcome (exit code, signal, timeout)

The adapter launches no processes, installs nothing, and changes no exit codes. The
result is `{ state: "available", report }`, or `state` is one of `missing`,
`malformed`, `unsupported-version`, or `oversized`.

Save the report as a JSON artifact and record it with `context.recordArtifact`,
keeping the body out of trace metadata ([artifact lineage](artifacts.md)). On Cloud,
upload it through the run-scoped artifact capability with a filename ending in
`.check-report.json` and type `application/json`. Persist the report **before**
turning the native nonzero exit into a step failure, and let the process outcome
still fail the check even if the report claims every test passed.

## Report contract (version 1)

`CheckReport`, `CheckProcessOutcome`, `CheckTest`, `CheckFailure`, limits, and
`readCheckReport` are exported from `tubeless/check-report`. A report describes one
invocation, not repository coverage, and contains:

- `version: 1`, tool name and version, and your invocation and source context
- the native process outcome, independent of test claims: exited, signalled,
  timed-out, cancelled, spawn-failed, or unavailable
- per-test file, suite ancestry, title, final outcome, and where available duration,
  location, and bounded failures; collection and setup failures are listed separately
- `completeness`, `truncated`, and `omittedTests`

Things to know:

- Test IDs encode `[relativeFile, suiteAncestry, title, duplicateOrdinal]` as JSON,
  with `/` paths relative to `root`. Outside-root paths and overlong identities are
  rejected, not clipped. Duplicate names carry `ambiguous: true`; select by file.
- Vitest supplies only final retry outcomes; attempt history is unavailable.
  Missing durations, locations, and causes stay absent, and failure text is not
  parsed for source locations.
- Limits: 2 MB of input JSON, 32 KiB and 128 tests in the normalized report (failed
  tests are kept first), four failures per test (2,000-character messages,
  4,000-character stacks), and 16 collection failures. Clipping sets
  `truncated: true` and `completeness: "incomplete"`. The decoder rejects
  oversized or invalid reports rather than accepting partial JSON, and drops unknown
  fields.
- `checkReportCompleteness` conservatively marks pending tests, unavailable process
  outcomes, and incomplete output as incomplete, even if uploaded JSON claims
  otherwise. Never treat absent diagnostics as a passing check.

## Cloud and CLI

Cloud keeps your `PipelineError` fields in bounded `structuredError` step snapshots
and `structuredErrors` run snapshots alongside the legacy `error` string: classification,
codes, stack, causes (four levels), validation issues, and fan-out details, each with
`truncated: true` on loss. Run-level errors keep eight entries plus
`omittedStructuredErrors`; each snapshot is capped at 12 KB
(`projectStructuredErrors`, `STRUCTURED_ERROR_LIMITS`). `cloud inspect --json`
preserves these fields on a retained snapshot. Foreground `cloud run --json`
and `cloud follow --json` return them after the run settles.

CLI inspection, the retained-run API response and hosted MCP `get_run` include `diagnostics` with up
to two report artifacts with their decoder state, plus `omitted`. `missing` means no
report was uploaded for a captured run; `unavailable` means the record predates
capture. Identities inside a report are untrusted claims; the enclosing run and
artifact name establish ownership. `nativeCommands` lists observed command exits
separately and never promotes exits from a report.

Read grants expose these bounded contents; downloading full artifacts still needs
`artifacts:read`. Workspace, pipeline, and retention checks apply to API and MCP,
and a report body cannot mint check receipts or deployment evidence.
