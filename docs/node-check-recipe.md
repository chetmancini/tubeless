# Portable Node checks

The portable recipe supports a single-package Node 24 / Bun 1.4.4 check
with Vitest 5.1.0 reports on Linux and macOS. Cloud pins the recipe to
Tubeless 0.4.3 and has qualified the wrapper in a disposable hosted proof.
Customer enrollment remains disabled.

Commit `package.json` with `"packageManager": "bun@1.4.4"`, `bun.lock`, and
`tubeless.check.json`:

```json
{
  "version": 1,
  "toolchain": { "node": "24", "bun": "1.4.4" },
  "checks": [
    { "id": "types", "script": "typecheck" },
    {
      "id": "test",
      "dependsOn": ["types"],
      "vitest": { "report": ".tubeless-reports/vitest.json" }
    }
  ]
}
```

Define `typecheck` explicitly in package scripts; use the command that checks your
repository. Pin `vitest` to `5.1.0` in `devDependencies`. Every configured check is
required. A missing script or a script name starting with `-` is a configuration error.
This initial version rejects
workspaces, alternate/mixed lockfiles, other toolchains, unknown configuration
fields, cycles, duplicate IDs and overlapping report paths.

Keep inspection separate from execution. For `scripts/check-plan.ts`:

```ts
import { readNodeCheckPlan } from "tubeless/node/check";
console.log(JSON.stringify(await readNodeCheckPlan(process.cwd()), null, 2));
```

For `scripts/check.ts`:

```ts
import { readNodeCheckPlan, runNodeCheck } from "tubeless/node/check";
const cwd = process.cwd();
const plan = await readNodeCheckPlan(cwd);
const execution = await runNodeCheck(plan, {
  cwd,
  log: { log: console.error, error: console.error, warn: console.error },
});
console.log(JSON.stringify(execution, null, 2));
process.exitCode = execution.run.status === "completed" ? 0 : 1;
```

Run `node scripts/check-plan.ts` under Node 24 to inspect the plan, then
`node scripts/check.ts` to execute it. Ordinary logs go to stderr, leaving stdout
as inspectable JSON. Install the candidate Tubeless package once to bootstrap
that entrypoint. It requires no Cloud login, provider SDK, container engine or
credentials. [The example](../examples/node-check.ts) also forwards SIGINT/SIGTERM
to an AbortSignal. Calling `runNodeCheck` directly accepts the same signal and
tracing context as ordinary pipelines. Preview reads files but launches nothing;
`{ dryRun: true }` structurally skips every command.

The pure `tubeless/check-plan` resolver distinguishes `install`, `script` and
`vitest` command kinds and exposes argv, script bodies, dependency
edges, reasons, deadlines and expected report files. It performs no I/O. The local
reader verifies regular JSON/lock files and rejects mixed lockfiles. Execution
validates and snapshots the supplied plan, then re-resolves the files and rejects
a changed plan before starting commands. Later caller mutations cannot change
the admitted commands.

Installation is always `bun install --frozen-lockfile`. Script checks run
`bun run --silent <script>`. Vitest checks run Node's pinned process binary with
`node_modules/vitest/vitest.mjs run --reporter=json --outputFile=<path>
--includeTaskLocation`. No console scraping or absent-script success is used.
The integration builds ordinary Tubeless steps: install is an implicit required
dependency, explicit prerequisites are required edges, fail-fast stops dispatch,
and in-flight work drains. `maxConcurrency` defaults to one and is bounded at
four. Check deadlines default to 60 seconds and cannot exceed five minutes;
installation has five minutes. A timeout/cancel terminates the process group,
then escalates to SIGKILL and closes inherited output pipes so descendants cannot
extend the deadline. Callers own signal wiring; abrupt process/VM loss
cannot guarantee report collection.

Each execution returns the original `PipelineRun`, native `CheckProcessOutcome`
records and expected `CheckReportResult` envelopes. Framework errors retain core's
classification. Test reports use the existing `tubeless/check-report` contract and
optional Vitest adapter. After a command settles, its report is read once, including
nonzero exits. Tests are never rerun for collection. Skipped checks produce missing
envelopes without reading stale output. Missing/invalid/incomplete reports after
an otherwise successful Vitest invocation fail the gate; a native failure always
remains a failure. A truncated report remains visibly incomplete.

Reports must be unique `.tubeless-reports/<simple-name>.json` files, at most two.
Paths that differ only by case are rejected so reports remain distinct on macOS and Linux.
Old files are removed before invocation. Directory/leaf symlinks and nonregular
files are rejected; reads are bounded even if files grow. Linux additionally
checks the opened file descriptor's resolved location. Raw input is limited to
2,000,000 bytes per file; normalized reports to 32 KiB, 128 tests and the existing
message/stack limits. Output streams drain with 128 KiB retained per stream per
command; omitted output makes process/report completeness false. Cloud adds its
own enclosing response, source, run retention and isolated guest limits.

The paired representative fixture is `scripts/fixtures/node-check`: a JavaScript
syntax gate and a real Vitest test. Changing `answer` from 42 to 41 exercises the
original failing invocation and available source location. It is not the package's
own CI suite and does not replace its Node 22/24/26 verification matrix.
The full Node 24 CI and release gates provision Bun 1.4.4 for this recipe;
the Node 22/26 lanes retain Bun 1.3.14 coverage for the package's runtime floor.

OSS owns the data contract, resolver, scheduler composition and adapter. Cloud
owns source verification, plan hashing, approved images/commands, isolation,
storage, authorization, retention and collection transport. Repository reports
remain untrusted inspection data. They cannot create check receipts, authorize a
deployment or override a supervisor's nonzero exit.

For an eligible Cloud run, [reproduce the pinned check locally](./reproduction-manifest.md)
from a manifest with the original source, plan and image identity. Cloud
production of these manifests depends on an OSS release containing the
manifest API and reproduction command.

Cloud rollout still requires its outbound-network, abuse and enrollment gates.
Additional package managers and languages, private registries, caches, service
containers and sharding remain outside the recipe.

## Discover and select Vitest files

Use `runNodeCheckFiles(plan, context, request)` from `tubeless/node/check` on a
trusted checkout. This call runs the frozen install and the configured
prerequisites before loading Vitest configuration in the same kind of bounded
subprocess used for the check. `readNodeCheckPlan`, request decoding, dry runs,
manifest parsing, and downloads remain passive.

Save this as `scripts/check-files.ts` in a recipe repository with a Vitest step
named `test` and an installed Tubeless package:

```ts
import { decodeNodeCheckFileRequest } from "tubeless/check-plan";
import { readNodeCheckPlan, runNodeCheckFiles } from "tubeless/node/check";

const cwd = process.cwd();
const [mode, ...files] = process.argv.slice(2);
const request = decodeNodeCheckFileRequest({
  version: 1,
  stepId: "test",
  mode,
  ...(mode === "selected" || files.length ? { files } : {}),
});
const result = await runNodeCheckFiles(
  await readNodeCheckPlan(cwd),
  {
    cwd,
    log: { log: console.error, warn: console.error, error: console.error },
  },
  request
);
console.log(JSON.stringify(result, null, 2));
process.exitCode =
  result.fileCheck.outcome === "inventory-complete" ||
  result.fileCheck.outcome === "subset-passed" ||
  result.fileCheck.outcome === "full-passed"
    ? 0
    : 1;
```

```sh
node scripts/check-files.ts inventory
node scripts/check-files.ts selected spec/check.case.js spec/archive.case.js
node scripts/check-files.ts full
```

| Request mode | What runs                                                                                                          | Successful `fileCheck.outcome`                                                      |
| ------------ | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| `inventory`  | The named Vitest step discovers files after its required prerequisites. The named step stops before running tests. | `inventory-complete`                                                                |
| `selected`   | The full check graph, with exact file selection at the named Vitest step.                                          | `subset-passed`, even when the requested set happens to cover every discovered file |
| `full`       | The full check graph, with full file evidence at the named Vitest step.                                            | `full-passed`                                                                       |

Installation, type checks, and other configured prerequisites keep their
existing dependency ordering. The named Vitest check runs configured global
setup and setup files when it runs tests. A different Vitest step follows the
original recipe if it runs as a prerequisite or another check. The original
`runNodeCheck` entry point keeps its v1 execution and diagnostic rules.

### File and evidence contract

Discovery uses Vitest 5.1.0's configured specification selection, the same
selection used by `vitest list --filesOnly`. It respects the resolved Vitest or
Vite configuration, including `include`, `exclude`, and the configured test
directory. Selection uses the discovered specification objects keyed by exact
path. The Vitest CLI's positional filters use substring matching.
[Vitest CLI discovery](https://vitest.dev/guide/cli.html#vitest-list) ·
[Vitest specification API](https://vitest.dev/api/advanced/vitest#getrelevanttestspecifications)

- File identities are repository-relative POSIX paths sorted by UTF-16 code unit.
  Paths must match exactly. Absolute paths, empty and dot segments, traversal,
  backslashes, colons, control characters, and ill-formed Unicode are invalid.
  Duplicate identities, including case or Unicode-normalization collisions, fail
  the request or discovery. Discovered files must be regular files beneath the
  real source root, with no symlink at the file or in its path.
- The limit is 4,096 files, 1,024 UTF-8 bytes per path, and 512 KiB for the
  serialized file list. Exceeding a limit fails explicitly. Discovery either
  returns the complete list or leaves `fileCheck.inventory` null.
- An inventory can be empty. A selected request requires at least one file.
  Invalid requests fail before execution. Unknown files fail after discovery,
  before any test runs at the named step. A file-aware full run with no files
  fails even when Vitest enables `passWithNoTests`.
- Browser and Vitest typecheck projects, shard/changed/related/last-failed
  filters, experimental pre-parsing, report merging, standalone, cache-clearing
  and tag-listing modes are unsupported in the file-aware contract. The contract
  uses Vitest's default file sequencer and built-in Node pools. Custom file
  sequencers, file shuffling, runners and pools are unsupported. Distinct
  configured projects can use it when every test file has a unique path.

`fileCheck.inventory` is version 1. It records the complete ordered file list,
step ID, base plan digest, observed `bun.lock` digest, exact Node, Bun and Vitest
versions, OS and architecture, and the primary config path and digest when
present. The config digest covers the primary file. Imported config, plugin
behavior, and environment inputs can affect resolution. Local commit and Git
tree identity are null because a working tree can contain edits and untracked
files. The inventory describes one invocation in one checkout.

`fileCheck.request` records the normalized v1 request and
`fileCheck.requestDigest` hashes canonical JSON of `{ planDigest, request }`.
`fileCheck.inventoryDigest` hashes the complete inventory with the same canonical
JSON and SHA-256/base64url encoding as the v1 plan. Those digest helpers and
`decodeNodeCheckFileRequest` are data-only exports from `tubeless/check-plan`.
The base plan and its digest retain their existing format. Each file-aware
invocation rediscovers the files before running the request.

`fileCheck.execution` records Vitest module completions independently of the
diagnostic JSON. A successful file-aware check requires a zero native exit, a
completed Vitest run, exact coverage of the requested file set, and at least one
passing test case. An explicitly skipped file can appear as `skipped`. Missing
or invalid evidence, a different observed file set, and failed prerequisites
prevent a pass. A dry run reports `not-run`. The bounded diagnostic projection
can omit tests while the inventory and file evidence remain complete.
[Vitest reporter lifecycle](https://vitest.dev/api/advanced/reporters#ontestmoduleend)

### Cloud C8a and O8b/C8b handoff

Use `fileCheck.inventory` and `inventoryDigest` to establish the file cohort.
Join `fileCheck.execution.files` by exact `path`, scoped to that inventory and
`stepId`. For timing samples, retain `state` and nullable `durationMs` from
Vitest's `TestModule.diagnostic().duration`. This is test and hook time in
milliseconds. It excludes install, global setup, module collection, and worker
startup. Use complete successful runs for baseline samples. Preserve null
timings as unknown and keep the native process outcome and scope label with
each sample. Keep any Cloud image, resource class, repository, commit and tree
identity from the same admitted and verified run. A local inventory digest by
itself cannot establish source provenance or timing comparability. Validate
version, limits, and digests before ingestion. Ingest idempotently using run
ID, step ID, and file path, and apply the existing tenant, pipeline, read
authorization, and retention boundaries.
[Vitest module diagnostics](https://vitest.dev/api/advanced/test-module#diagnostic)

The Cloud CLI and hosted admission currently accept legacy plan v1 only.
Before accepting file-aware requests, Cloud needs a runner capability that
explicitly supports file-request v1 and a strict admission envelope. Reject
unknown capabilities, versions, and fields before dispatch. Bind the exact
canonical request and its digest to the approved base plan, verified source,
image, and run identity. Retain native status and independently require exact
completion evidence. Gate the UI and CLI on the capability. A file-aware run
is ineligible for reproduction manifest v1.

O8b can consume a complete validated inventory and compatible file timings
once its partitioning contract is ready. C8b needs the bound inventory
identity at dispatch and must fail closed if rediscovery shows drift. An
aggregate full pass requires successful execution and complete, disjoint
coverage of the same inventory plus the required check prerequisites. A
single `subset-passed` result carries only its requested scope.
