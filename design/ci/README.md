# CI roadmap for Tubeless OSS

Status: O1 implemented locally; O2–O9 proposed, November 3, 2026.
No release commitments or hosted rollout claims.
Assessed against OSS `8f932a247328ea0f6e2f898cf3792e1412f87ae4` and
Cloud `01ca1b89a75eb63eab631877f3052e97b01cf1c0`. Recheck those contracts before
implementation. O1–O9 and C1–C9 identify research deliverables, not release numbers.

Bring the portable parts of the Cloud CI investigation into OSS: supported
automation, inspectable failures, an executable check recipe, and local
reproduction. Start with a bounded Linux/Node workflow. Whether this is the best
market for Tubeless remains a product hypothesis; demand, performance and
economics have not been established by this planning work.

## Source and scope

The maintainer requested this transfer from BB thread `thr_fc6v4d5cg7` to
`thr_a2p27ndnjt`. The source thread supplied a read-only handoff on November 3.
Its ignored research files in the sibling Cloud checkout are
`artifacts/ci-market-assessment-2026-11-03.md`,
`artifacts/ci-oss-delivery-order.md`, and `artifacts/ci-cloud-delivery-order.md`.
This tracked document carries the decisions and dependencies needed here;
implementers do not need those ignored files to understand the roadmap.

The research described fixed operator recipes with customer native CI still
requiring productization and rollout. It reported Cloud pinned to Tubeless
0.3.8 while this package is 0.3.9. No publication, deployment, provider capacity
test or customer acceptance was performed for this transfer. Green OSS checks
do not upgrade the Cloud runtime or activate a hosted feature.

## Reuse what ships

| Foundation                        | Current evidence                                                                                                           | What remains to productize                                                                                       |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Typed DAG execution and selection | [Core controls](../../src/core/pipeline-types.ts), [check pipeline](../../scripts/check-pipeline.ts)                       | An explicit portable check recipe; test-aware selection and partition planning                                   |
| Fail-fast and cancellation        | [Concurrency guidance](../../docs/agent-guide.md#concurrency)                                                              | Preserve stop-dispatch-and-drain behavior; remote cancellation needs a service operation                         |
| Framework errors and tracing      | [Error normalization](../../src/core/pipeline-execution-error.ts), [trace schema](../../src/tracing/tracing-schema.ts)     | Native process outcomes, tool/test reports, and lossless Cloud projections where fields are currently flattened  |
| Artifacts and run history         | [Artifact contracts](../../docs/artifacts.md), [source ownership](../../src/README.md#history-and-studio-ownership)        | Portable report/manifest formats and authorized byte retrieval; artifact metadata does not fetch or verify files |
| Step-result caching               | [Cache contracts](../../docs/step-output-cache.md), [R2 adapter](../../src/cloudflare/cloudflare-cache.ts)                 | Preparation identity and adapters only if a real prewarming consumer needs them                                  |
| Child and remote work             | [Child composition](../../docs/child-pipeline-composition.md), [remote composition](../../docs/remote-step-composition.md) | Compose test partitions without another scheduler; fleet admission remains external                              |
| Cloud CLI and credentials         | [Command](../../src/workbench/cloud/command.ts), [credentials](../../src/workbench/cloud/credentials.ts)                   | Characterize existing automation access, then fill scope, source and admission-recovery gaps                     |
| Agent recovery and MCP            | [Agent guide](../../docs/agents.md), [MCP client](../../src/agent/mcp.ts)                                                  | A separate optional CI-control MCP server; agent checkpoints do not make arbitrary CI effects safe to replay     |

The self-hosted [Cloudflare target](../../docs/deploy-cloudflare.md) remains a
team deployment integration. It does not supply multi-tenant native CI or an
enrolled BYOC fleet. Step-result caches, dependency filesystem snapshots and
compiler caches have different correctness contracts.

## Delivery order

Sizes are relative scope estimates: S is one focused slice, M spans several
modules/contracts, and L needs a separate infrastructure or product decision.
They are not calendar estimates. O1 has local implementation/validation evidence
in its linked plan; the remaining items are proposed.

| Order | Deliverable                                           | First useful result                                                      | Dependencies                                                            | Size                       |
| ----- | ----------------------------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------- | -------------------------- |
| O1    | [Supported automation CLI](./automation-cli.md)       | Scoped headless access, exact source, recoverable admission identity     | Existing Cloud API; no new Cloud API required for the first slice       | S–M                        |
| O2    | [Structured diagnostics](./structured-diagnostics.md) | One usable Vitest report, preserved framework errors and native exits    | Independent of O1; coordinate Cloud C4 projection                       | M                          |
| O3    | [Portable Node check recipe](./node-check-recipe.md)  | One explicit definition usable locally and by an approved hosted wrapper | Agree policy with Cloud C2; O2 enriches reporting                       | M                          |
| O4    | Reproduction manifest and local replay                | Verified pinned fixture rerun on a supported local container host        | O3; O2 report linkage; agree Cloud C2/C6 source and image access        | M                          |
| O5    | Complete CLI job controls                             | Inspect output, retrieve artifacts, explicitly cancel, resume following  | O1/O2 and Cloud C4/C5; C6 for manifest retrieval                        | M                          |
| O6    | Optional CI MCP server                                | Bounded tools over accepted client operations                            | O5 operations and corresponding Cloud scopes                            | S–M                        |
| O7    | Repeatable benchmark harness                          | Raw comparable samples with phase timings and failures                   | Begin with O2/O3; O1 enables hosted automation                          | S–M                        |
| O8    | Test selection and balanced partitions                | Explicit test selection and deterministic local partition plan           | O2 stable test IDs and O3 invocation; C8 only for hosted timing history | M                          |
| O9    | Preparation identity and adapters                     | Correctly keyed dependency reuse for an actual consumer                  | O3/O4, measured install cost, and Cloud C9 design                       | S–M OSS; larger Cloud work |

Start O1 and O2 independently while Cloud C1 qualifies existing hosted checks.
Agree O3's recipe during C2's customer-pilot design. Start collecting timings
then; O7 is not a reason to postpone measurement until the end of the list.
O4 and O5 can proceed together once their distinct contracts are agreed.
O6 follows proven client operations. O8 and O9 are independent optimization
choices after pilot evidence, unless measurements justify moving one earlier.

## Later deliverables and acceptance gates

### O4: reproduce a recorded check locally

Define a bounded, versioned manifest containing source commit/tree and lockfile
digests, recipe/version/ordered commands, immutable image digest, toolchain and
OS/architecture, allowlisted nonsecret setup, and required artifact identities.
Separate historical run references from the fresh local execution identity.
Begin with a manifest file and pinned fixture; choose a supported local container
engine and host architecture before building a replay command. Proposed format
ownership is optional Node integration, outside core and agent recovery.

Acceptance: a clean supported host reruns a controlled failed fixture; tampered
digests, missing or expired inputs, unsupported architecture and unsupported
versions fail explicitly. Extracted paths cannot escape the workspace. Command
execution is explicit, and credentials never enter the manifest. A matching
environment cannot guarantee the same result for external or nondeterministic
dependencies. Replay cannot mutate or mint a historical Cloud check receipt.

Cloud C6 must export historical identities and provide authorized source/image
access. Distribution of the current private runner image is unresolved. A local
fixture can ship before that handoff; do not advertise Cloud reproduction until
the released command consumes a real authorized export.

### O5: inspect and control an existing Cloud job

Extend the existing bounded Cloud client with accepted service contracts, rather
than introducing another transport. Deliver filtered diagnostic/log pages first,
then authorized artifact/manifest downloads and explicit cancellation, then
cursor-based following. Proposed command names are not API commitments.

Acceptance: a headless client reconnects to the original run after losing a
connection, preserves cursor progress, and returns stable terminal JSON and exit
codes. Retention gaps, truncation and expired cursors are visible. Stopping local
following keeps remote work running; remote cancellation is an explicit action.
Downloads enforce size/digest/path limits. Older services report unsupported
capabilities without guessed endpoint fallbacks or implicit resubmission.

Cloud C4 owns queries, download/cancel endpoints and their new permissions; C5
owns event delivery, cursor retention and revocation behavior. Existing read/run
automation grants do not grant cancellation or artifact bytes. Fixture development
can precede deployment; hosted acceptance cannot.

### O6: expose proven operations to MCP clients

Build thin optional server tools over O5's client operations, beginning with
status and diagnostics if those are ready first. Tool descriptions state side
effects, permissions, idempotency and truncation. Bound response sizes and waits.
Choose packaging and transport from actual consuming clients; the existing
`tubeless/agent/mcp` entrypoint connects to servers and should keep that role.

Acceptance: an MCP client inspects a controlled failed check using scoped access;
submit/wait/cancel tools, when added, retain the same admission and cancellation
semantics as the CLI. Denied scopes stay denied. No separate executor, tenant
policy, credential issuer or receipt writer is introduced.

### O7: measure a fixed workload repeatably

Create a fixed corpus and versioned raw-result format with commit, machine,
image/toolchain, sample count, failures and cold/warm definitions. Record queue,
preparation, boot, install, execution and cleanup separately when observed.
Represent unavailable timings as unavailable, never zero. Retain failed samples,
omission reasons and timing provenance; report distributions rather than one run.

Acceptance: another developer can repeat the documented local protocol and inspect
all raw samples. Hosted and local work use equivalent source/commands, with their
environment differences recorded. Hosted sampling uses the accepted Cloud API.
Measured usage, estimated cost and provider invoices remain distinct. No speed
or pricing superiority is implied. Cloud C7 owns public beta terms/economics.

### O8: select tests and partition by observed duration

Use O2's file/test identities and explicit selectors first. Then add a pure
deterministic partitioner over local timing reports, with conservative estimates
for new tests and deterministic tie-breaking. Expose the selected set, assignments,
timing provenance and completeness. Invoke partitions with ordinary pipelines
and child/fan-out controls; no distributed scheduler is needed for local work.

Acceptance: every selected test is assigned exactly once; input ordering cannot
change a normalized plan; missing/stale timings cannot omit work. Duplicate or
ambiguous test identities fail or use a documented file-level fallback. Required
build/setup dependencies remain selected. A selected subset never claims full-suite
coverage, and failed/incomplete telemetry stays failed/incomplete. Cloud C8 supplies
historical storage, not the local partition algorithm. Automatic impact inference,
quarantine and bisection are separate decisions.

### O9: reuse dependency preparation only when it pays

First measure cold installs using O7. If Cloud C9 chooses filesystem preparation,
agree identity over lockfile, immutable image, toolchain, setup definition,
OS/architecture and repository/trust namespace. Reuse existing store/codec and
artifact contracts where they fit. Add an adapter only with an actual consumer;
do not publish a standalone speculative metadata helper.

Acceptance: any relevant input change causes a miss; corrupt state is detected;
untrusted work cannot choose a trusted namespace; bypass and a correct cold path
remain available. Cloud authorizes namespace assignment and enforces quotas,
retention and provenance. No promise of live process restoration, generic remote
compilation caching or unlimited storage follows from this feature.

## Ownership and explicit deferrals

| OSS owns                                                           | Cloud owns                                                                      |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| Portable execution, selection, cancellation semantics and adapters | Tenant admission, machine scheduling/isolation/cleanup and source authorization |
| Diagnostic, test and reproduction formats                          | Authorized storage/query/retention and trusted supervisor receipts              |
| CLI and optional MCP clients/server tooling                        | Credential issuance/revocation, delegated permissions and atomic budgets        |
| Cache contracts and necessary preparation adapters                 | Hosted cache service, trust separation and quotas                               |
| Correlation and observable timing contracts                        | Usage reservations, pricing, invoices and public service commitments            |
| Local recipes and replay tooling                                   | Qualified images, GitHub orchestration, enrollment and rollout evidence         |

Defer Actions compatibility/migration, persistent development environments,
multi-OS/hardware fleets, native BYOC/hybrid scheduling, autonomous repair,
merge queues and enterprise operations. Broader Python/Rails and service recipes
need concrete consumers and qualified environments. Agent/checkpoint capabilities
do not justify automatically replaying uncertain CI side effects.

## Implementation and validation policy

Keep core dependency-free and preserve [module ownership](../../src/README.md).
Use optional integrations for process/container/tool/MCP dependencies. Start with
existing contracts; expand public declarations only when a consumer needs them.
Read the local [pipeline skill](../../skills/tubeless/SKILL.md) when modifying
pipelines. Keep executable examples on public imports.

Each implementation runs meaningful focused checks and `make check`. Intentional
declaration changes require `bun run api:generate` and review of the generated API
diff. Validate the packed CLI and paired Cloud fixtures, not just source imports.
When behavior/recommended usage changes, update recipes, project registration and
agent guidance as applicable, and rebuild human-facing docs with
`make website-build`. Cloud deliberately updates its pinned package and runs its
own gate before claiming hosted support.

Immediate next work: coordinate O1's Cloud documentation/e2e-fixture follow-up
and begin O2's contract inventory. Record actual behavior before selecting
public diagnostic APIs.
