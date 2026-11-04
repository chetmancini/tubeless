# O3: one portable Node check recipe

Status: proposed. Priority: after the first O1/O2 slices; contract work can start
alongside them. Size: M. Baseline: OSS
`8f932a247328ea0f6e2f898cf3792e1412f87ae4`, Cloud
`01ca1b89a75eb63eab631877f3052e97b01cf1c0`, November 3, 2026.

Ship one explicit recipe that runs a supported Node/Bun repository gate locally
without Cloud login and supplies the same command/dependency definition to an
approved hosted wrapper. Start with this repo or a minimal representative fixture.
See the parent [roadmap](./README.md) for other deliverables.

## Start from the actual gate

[scripts/check-pipeline.ts](../../scripts/check-pipeline.ts) already defines
lint, Knip, formatting, typecheck, docs, API, Studio, tests and packed verification,
then a quality gate requiring every result. [package.json](../../package.json)
builds first and runs that command with continue-on-error and concurrency four.
[Makefile](../../Makefile) exposes it as `make check`.
[GitHub CI](../../.github/workflows/check.yml) runs the complete gate on Node 24,
and tests/package smoke lanes on Node 22 and 26. The portable example must not
silently redefine that contract or claim one local lane covers the full matrix.

The script's commands are specific to Tubeless. Do not copy all of its checks
into a universal preset or recurse from a generated recipe into `make check`
and back into itself. Use its existing public-import pipeline composition as
the pattern, and extract only demonstrably shared mechanics.

The Cloud handoff identifies `pipelines/check-definition.ts` as its corresponding
definition. Cloud C2 must agree the recipe identity/version, supported toolchain,
command IDs and qualified image. Cloud retains admission and trusted policy;
an arbitrary customer recipe cannot choose privileged images or publication rights.

## Product shape and slices

1. Build a clean consumer fixture with explicit argv commands, cwd, a supported
   package manager and toolchain, lockfile, setup/build prerequisites and a
   declared terminal gate. Use [the local authoring skill](../../skills/tubeless/SKILL.md)
   and public `tubeless`/`tubeless/cli`/`tubeless/project` imports. A recipe/example
   is sufficient initially; do not introduce a preset registry or runner framework.
2. Explain the selected commands and environment in a plan without executing them.
   Use existing step/target/concurrency controls. Model required setup/build work
   through dependencies. Keep direct step selection's existing semantics explicit:
   `stepIds` does not automatically include prerequisites.
3. Execute with optional Node process mechanics from O2. Preserve argv, cancellation,
   dry-run policy and command failure. Do not cache arbitrary check commands merely
   because step caching exists. Rich reports can be added after basic exit handling.
4. Document explicit configuration and overrides. Start with a pinned Bun-lockfile
   fixture; broader Node package-manager support needs its own qualified fixture.
   If auto-detection is added, multiple/unknown lockfiles or missing scripts must
   request explicit configuration, never guess a passing gate. Use frozen installs.
5. Compare the normalized definition locally and in Cloud's approved wrapper:
   ordered command IDs/argv, dependency graph, toolchain/lock identity and source
   revision. Cloud may execute native commands under its supervisor rather than
   running an untrusted pipeline definition as authority. Record intentional
   environment differences and test the common definition.

No Cloud login, provider SDK or container engine is required for the local recipe.
A production container replay command is O4. Customer native enrollment, source
archive verification, outbound restrictions, secret policy and machine cleanup
belong to Cloud C2/C3 and cannot be implemented by changing this example.

## Acceptance

| Scenario                       | Required result                                                                                                 |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| Clean supported fixture        | Full gate runs locally with public package imports and frozen dependencies                                      |
| Plan/dry run                   | Plan starts no process; mutation/install/check handlers obey their explicit dry-run policy                      |
| Failed prerequisite            | Dependent work does not run; terminal gate cannot report success                                                |
| Fail-fast/concurrency          | Uses existing stop-dispatch/drain behavior and configured admission bound                                       |
| Cancellation                   | Stops further dispatch and propagates abort to the child process; final result is not success                   |
| Unsupported or ambiguous setup | Useful configuration error before executing guessed commands                                                    |
| Local/hosted comparison        | Same recorded source, normalized commands/dependencies and recipe version; qualified image differences explicit |
| Hostile report or result       | Cannot choose Cloud policy or mint a trusted successful-check receipt                                           |

## Files and validation

Proposed additions are a small executable example under `examples/` and an adjacent
public-example test under `src/testing/`. Register it in an example project only
when shared CLI/Studio discovery needs it; keep each pipeline registered once.
Reuse `scripts/run-pipeline-command.ts` only after deciding whether its internal
location remains appropriate. Optional reusable process helpers belong under
`src/node/`, never core. Avoid unrelated changes to the existing CI matrix.

Read [docs/agent-guide.md](../../docs/agent-guide.md) before implementing. Compile
with `bun run typecheck`, and exercise the example using fake process I/O before
one disposable clean-fixture run. Test nonzero exit, cancellation and prerequisite
selection with the changed adjacent Vitest files. Run `make check`, including
packed public-import verification. Update recipes, example project registration
and agent guidance as applicable; run `make website-build` when adding user docs.
If public declarations change, generate/review the API report.

The local recipe can ship independently. Hosted parity is accepted only after
Cloud runs the agreed definition at a fixed revision through its qualified recipe.
Do not weaken Cloud policy to execute arbitrary commands or imply Actions
compatibility. If sharing definitions would require importing Cloud runtime code
into OSS core, stop and redesign the data/adapter boundary.
