# O2: structured check diagnostics

Status: proposed. Priority: first, independently of O1. Size: M across slices.
Baseline: OSS `8f932a247328ea0f6e2f898cf3792e1412f87ae4`, Cloud
`01ca1b89a75eb63eab631877f3052e97b01cf1c0`, November 3, 2026.

Let a developer or agent identify a failing command/test from bounded structured
data, while keeping raw-output references and uncertainty. Start with one Vitest
report adapter; TypeScript locations are a separate slice. The parent
[roadmap](./README.md) records dependencies and Cloud ownership.

## Existing contracts and actual losses

[Pipeline errors](../../src/core/pipeline-types.ts) and
[normalization](../../src/core/pipeline-execution-error.ts) already preserve
framework code, kind, phase, step ID, source code, causes, stack, validation
issues and bounded fan-out failures. [Trace schemas](../../src/tracing/tracing-schema.ts)
and [codecs](../../src/tracing/tracing-codec.ts) carry typed lifecycle events.
Do not replace these with another generic error taxonomy.

[The repository command helper](../../scripts/run-pipeline-command.ts) launches
argv without a shell and forwards cancellation. It converts nonzero exit/signal
into error text, and buffers stderr before logging it. A native exit code, signal,
channel and incomplete capture cannot be recovered reliably by parsing that text.
The helper is internal automation, not an exported general runner.

[Agent environment commands](../../src/agent/environment.ts) already distinguish
exitCode, signal, timedOut and truncated. Use that as evidence for useful fields,
not as a reason to depend on agent execution from a check integration.
[Artifact metadata](../../docs/artifacts.md) can reference a large versioned
report without stuffing test lists into trace attributes. Metadata alone does not
fetch bytes, verify contents, or prove successful execution.

The Cloud handoff identified flattened step errors and bounded log snapshots in
Cloud `src/worker/cli-response.ts`. First distinguish existing trace information
lost during projection from tool/process facts that were never recorded.

## Contract inventory before public API changes

Produce fixtures mapping a failed step through local report, trace codec,
history JSON and Cloud response. Record where each useful field disappears.
Fix Cloud projection loss in Cloud; do not expand OSS core to replace data it
already emits. Recheck the Cloud revision before agreeing fixtures.

For new information, begin with a versioned bounded check-report artifact:

| Group               | Minimum proposed information                                                                                |
| ------------------- | ----------------------------------------------------------------------------------------------------------- |
| Provenance          | Schema/tool version, source/recipe identity, pipeline/run/step/attempt association                          |
| Process observation | Integer exit or null, signal or null, timeout/cancellation/spawn-failure observations, capture completeness |
| Diagnostics         | Tool category, message, optional file/location, raw-output artifact reference and omission counts           |
| Tests               | Stable file/suite/test identity, outcome, duration when observed, attempt and report completeness           |
| Output              | Channel and digest/size reference, explicit truncation/missing state; no large inline log arrays            |

Field names and public export placement require consumer review. Prefer artifact
payloads for report detail. Add trace/error fields only if typed consumers need
them for inspection without loading the report. Any addition must update the
decoder, projections and compatibility fixtures together. Keep tool integrations
outside core; a new adapter framework or public subpath is not assumed.

Repository-produced reports are untrusted observations. Only the external
supervisor can establish native exits and trusted check receipts in Cloud.
Keep claimed tool results and host observations distinct. Unknown/missing data
must not become a passing test or a trusted successful job.

## Implementation slices

1. Inventory existing fields and round-trip failures. Preserve framework errors
   through the local and Cloud-facing paths before adding new types.
2. Add one fixture-driven Vitest machine-report decoder with stable test identity,
   outcome, observed duration and explicit completeness. Verify the currently
   installed Vitest reporter contract before relying on its format. Start with
   a recipe-owned adapter; extract a reusable module only when a consumer needs it.
3. Capture structured process outcomes in optional Node code. Bound stdout and
   stderr by bytes and report discarded output. Drain streams on exit/abort, keep
   argv boundaries, and distinguish spawn failure, timeout, cancellation and code
   failure. Reuse the existing command helper where appropriate without changing
   core scheduling or fail-fast semantics.
4. Link report and raw-output artifacts to the owning step/attempt using existing
   artifact recording. Keep large manifests and report bodies out of metadata.
5. Coordinate C4's Cloud decoder/projection with identical fixtures. Add a
   TypeScript diagnostic adapter separately after the Vitest path is useful.

Stable IDs need explicit rules for relative path normalization, suite ancestry,
parameterized tests, retries and duplicate names. Do not use duration or source
line numbers as sole identity. If the tool cannot supply unambiguous test IDs,
record ambiguity and use file-level selection until O8 resolves it.

## Files, acceptance and verification

Start from `scripts/run-pipeline-command.ts` and its adjacent tests; optional Node
implementation belongs under `src/node/` if reused publicly. Preserve ownership
in [src/README.md](../../src/README.md). Relevant integration tests live beside
`src/tracing/`, `src/run-store/`, `src/workbench/` and `src/testing/` consumers.
Do not add Vitest/TypeScript runtime imports to core or introduce Studio/storage
dependencies into public pipeline execution.

Required fixtures: failing/passing/duplicate/parameterized/skipped/retried tests;
zero exit with missing report; nonzero exit with all recorded tests passing;
timeout/cancellation/signal/spawn failure; invalid/oversized/truncated/partial
report; unsupported tool version; Unicode paths and hostile terminal text.
Observed nonzero exit or incomplete capture cannot be overwritten by claimed
report success. Missing duration remains missing, not zero. Unknown tool output
keeps a bounded raw reference and explicit unknown classification.

Run `bun run build`, then the changed adjacent tests with
`bunx vitest run <changed-test-files> --config vitest.config.ts`. Include trace
codec/history round trips and old-recording compatibility whenever fields change.
Run `make check` and public-import example/packed checks. Regenerate API artifacts
with `bun run api:generate` only for intentional declaration changes. Update
artifact/recipe/agent guidance and rebuild the website when recommended usage
changes. Cloud projection acceptance requires its own fixtures/gate and explicit
runtime pin update, not just a green OSS build.

First slice is done when one controlled failed Vitest fixture yields stable test
identity/outcome/duration and a usable raw-output reference locally. Cloud parity
is a separate acceptance gate. Stop for contract review if this requires a new
generic trace event or public error taxonomy rather than an optional report.
