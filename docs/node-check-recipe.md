# Portable Node checks

Candidate O3 slice: a single-package Node 24 / Bun 1.4.4 recipe with Vitest
5.1.0 reports on POSIX hosts (Linux and macOS). Windows execution is rejected
before launching commands because process-tree cancellation is not supported there.
This API is newer than published Tubeless 0.4.2. Cloud's paired
wrapper is an implementation/fixture integration pending an OSS release, Cloud
pin update and hosted qualification. Customer enrollment remains disabled.
The earlier `design/ci/node-check-recipe.md` proposal was removed in the repository's
November documentation cleanup; this document records the implemented slice.

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

Remaining work: publish the new entrypoints and replace Cloud's temporary O3 source
bridge with that pin; qualify the wrapper on the approved hosted image at an exact
revision; validate cold start, cancellation/timeout/restart and cleanup there;
complete C2/C3 outbound-network, abuse, enrollment and rollout gates. Additional
package managers/languages, private registries, caches, service containers, test
selection, sharding and reproduction are deferred.
