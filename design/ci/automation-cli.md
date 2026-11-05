# O1: supported headless automation and precise admission

Status: implemented locally; publication and hosted rollout are unverified.
Priority: first, independently of O2. Size: S–M.
Baseline: OSS `8f932a247328ea0f6e2f898cf3792e1412f87ae4`, Cloud
`01ca1b89a75eb63eab631877f3052e97b01cf1c0`, November 3, 2026.

Make the existing CLI a supported scoped-automation interface. A run-only grant
should submit a known pipeline ID without a read request. An uncertain admission
should be recoverable across CLI invocations without creating another job.
The parent [roadmap](./README.md) records broader sequencing and ownership.

## Implemented result

The CLI reuses `TUBELESS_TOKEN` with explicit workspace selection, submits a
known ID without discovery, supports simple GitHub refs through `--ref` and
advanced `--source <json|@path|->` selectors, and accepts
`--idempotency-key` for deliberate retries across invocations. It explains
session-only auth status and preserves admitted run identity if following is
denied. Read-only, restricted and revoked credentials remain service-enforced.
Input/source/key validation, command-specific help/completion and user/agent
guidance are covered in the package checks. No public runtime API changed.

Focused tests and packed-executable fixtures exercise the supported path. The
packed fixture scripts HTTP exchanges and checks the installed executable's
requests/output. Cloud's maintained `scripts/cli-e2e.mjs` suite now also runs
`tests/cli-automation.integration.mjs` against the actual service harness. It
covers scoped grants, lost acknowledgment, single reservation, provider-unavailable
replay, conflicts, main/PR/ref selection, restrictions and revocation. The earlier
scratch-adapter cases are preserved there. This is local service integration
evidence, not production acceptance.

Cloud follow-up: reconcile its session-only CLI documentation. Keep
deployment/version rollout separate from the OSS implementation.

The paired Cloud ref contract adds `{ kind: "ref", ref }`. The CLI forwards
case-sensitive branch/tag/full-or-short-SHA values without local Git resolution.
Cloud pins the full commit, and retries preserve the literal ref intent and the
original admitted snapshot. Omission keeps the configured branch HEAD behavior.
`--ref` and `--source` are mutually exclusive. The client matches Cloud's ref
validation and 68 KiB request envelope while retaining the 64 KiB input limit.

November 4 staging smoke: authenticated ref admission reached the expected
empty-secret-scope policy guard on the existing QA pipeline and admitted no run.
Successful ref resolution/replay is validated through isolated service fixtures;
successful live staging execution still needs a qualified secretless pipeline.
The current build passes all 27 maintained CLI integration checks, including
the 18 automation cases and branch/tag/short-SHA cases.

## Planning baseline and confirmed gaps

- [Credential resolution](../../src/workbench/cloud/credentials.ts) accepts
  `TUBELESS_TOKEN` before lazily accessing native storage.
- [Token validation](../../src/workbench/cloud/protocol.ts) accepts bounded
  printable ASCII, not a session-specific bearer format.
- [Cloud commands](../../src/workbench/cloud/command.ts) call `/session` only
  when `--workspace` is missing. The existing test named
  `explicit workspace bypasses session enumeration and remains authoritative`
  in [command tests](../../src/workbench/cloud/command.test.ts) verifies this.
  Thus basic automation with explicit workspace may already work. Cloud's
  current docs claiming it cannot work need contract verification, not a new
  transport implementation.
- Submission always lists pipelines, even with `--id`. That requires read scope
  unnecessarily when a run-only caller already supplied the ID.
- `CliRunRequest` contains only pipeline ID and input. Cloud already accepts
  immutable main/PR `source` selectors; this CLI cannot transmit them.
- Admission generates one random key and reuses it for a bounded transport retry.
  An uncertain response prints that key, but a fresh CLI invocation generates a
  different key and cannot deliberately replay it.
- Foreground following requires retained-run reads. `--detach` returns after
  admission and can support a run-only grant once discovery is avoided.

Cloud currently grants `read` and `run` separately, with pipeline allowlists,
expiry/rotation/revocation and required idempotency for automation. Run-only
admission replay returns the original receipt, not later private results/logs.
Client validation cannot replace the service's authorization or source checks.

## Scope and implementation slices

### 1. Establish the supported credential path

Use fixtures around [client tests](../../src/workbench/cloud/client.test.ts),
[credential tests](../../src/workbench/cloud/credentials.test.ts), and command
tests to require no keychain access and no `/session` call with an injected bearer
and explicit workspace. Cover list/read/run and restricted grants separately.
Follow existing injected `fetch`, `env`, `store` and I/O seams.

Keep `TUBELESS_TOKEN` as the default proposed automation path. Add another
environment variable only if tested behavior or a concrete consumer requires it;
an alias is not a deliverable. With a recognized automation bearer and no workspace,
prefer a useful explicit-workspace error over session discovery. Do not decode a
token to establish trusted permissions. Interactive login/status/logout retain
their session semantics; automation failures should explain those limits.

First checkpoint: establish whether the current packed executable works against
Cloud's automation fixtures. Record the result and reconcile the contradictory
Cloud docs in a paired change; do not claim live acceptance from mocked HTTP.

### 2. Submit a known ID without reading

Branch on explicit ID before pipeline discovery. Let Cloud validate availability,
pipeline restrictions and authority. Name/slug resolution still needs read scope.
Allow known ID plus `--detach` with a run-only grant. Explain that waiting needs
read scope; if a request has already been admitted, retain and print its ID even
if following is forbidden. Do not infer scope from an opaque credential or perform
an extra admission to recover from a follow error.

### 3. Propagate exact source and intentional retry identity

The accepted CLI syntax is `--source <json|@path|->`: the existing Cloud selector
object can be inline JSON, an explicit `@file`, or stdin. This identifies source
selection independently of how the object is supplied. Use `--idempotency-key`
for intentional replay; keep input and normalized selector unchanged.

Extend the internal request contract/validation with only the service-supported
main commit or PR number/head/base/merge selector. Require full SHAs and reject
ambiguous/unknown fields. Omission keeps latest-branch behavior. Do not fall back
to HEAD if immutable selection is denied or unavailable, and do not let selectors
choose repositories, commands, secrets, images or trusted receipts.

Preserve the exact normalized pipeline/input/source and key for each transport
retry. Caller-supplied key reuse across invocations makes recovery deliberate;
changed intent must yield the service's conflict. Emit enough nonsecret identity
to recover an uncertain admission. Avoid a new on-disk credential/recovery store.
Do not turn 5xx, interrupted POST or invalid responses into proof of rejection.

## Files and boundaries

Primary ownership: `src/workbench/cloud/{command,client,protocol,credentials,shared}.ts`
and adjacent tests; workbench command specs/completion for reviewed flags. Keep
host normalization, response limits, redirect rejection and safe diagnostics in
the existing modules. No new public runtime entrypoint or core change is expected.
Update [CLI guidance](../../docs/cli.md) and packed command coverage in
[artifact verification](../../scripts/verify-packed-artifact.mjs). Coordinate
Cloud docs and integration fixtures in its own checkout/review.

## Acceptance and verification

| Scenario                                         | Required evidence                                                                           |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| Explicit workspace + automation bearer           | No browser, OS secret-store call or session enumeration; working list/read with read scope  |
| Known ID + run-only + detached                   | One POST, no preceding pipeline GET; no result/log read required                            |
| Read-only grant submission                       | Service denial; no local scope bypass                                                       |
| Restricted/expired/revoked/cross-workspace grant | Useful bounded error; no secret in stdout, stderr or trace                                  |
| Lost admission acknowledgment                    | Retry has identical key and canonical intent; one admitted run                              |
| Deliberate retry in a new invocation             | Original admission is returned; changed input/source conflicts                              |
| Exact main/PR source                             | Expected selector transmitted and accepted identity displayed; no implicit HEAD replacement |
| Follow failure or local interruption             | Original run identity retained; no implicit remote cancellation or resubmission             |
| JSON and human output                            | JSON remains parseable on stdout; diagnostics use stderr and safe terminal rendering        |

Run `bun run build`, then
`bunx vitest run src/workbench/cloud --config vitest.config.ts` for the focused
loop. Run `make check` for handoff, including packed artifact checks. Extend
Cloud's `scripts/cli-e2e.mjs` or equivalent accepted fixture against the installed
package for actual grant scopes and source behavior. Rebuild the website after
user docs change. Report local fixtures, service integration and live acceptance
separately.

Stop and record a paired Cloud dependency if the service cannot return an
admission using run-only scope or if its selector/receipt shape has changed.
Do not broaden token permissions to make a client test pass.
