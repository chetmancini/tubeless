# Deploy to Cloudflare

Run Studio and your pipelines in your own Cloudflare account. `tubeless init cloudflare`
scaffolds a Worker that serves Studio behind Cloudflare Access, launches commands
from your project, and keeps history in Durable Objects.

```text
Browser → Cloudflare Access → Worker → TubelessStudio (history, launches)
                                     → TubelessRun (one object per run)
                                     → R2 bucket (cache entries, your artifacts)
```

It is one trust domain: everyone Access admits sees all history and can launch every
command. Pipelines run in the Worker runtime, so handlers must work on Workers. Read
[Run limits](#run-limits) before deploying anything long-running.

## Five-minute deploy

## Set up a named remote

```sh
bunx tubeless remote create --provider cloudflare
bunx tubeless remote run <command-id> --remote <name>
```

The wizard uses the Cloudflare CLI on Node.js and browser sign-in through
`cloudflared`. Enable Zero Trust in the account before running it. Choose the
Cloudflare account, Worker name, and email allowed to use Studio. Tubeless uses the
existing Cloudflare scaffold, provisions the Worker and its storage, configures
Worker-level Access, and saves the remote after verifying the authenticated
execution API. Rerun the wizard in the same project to resume after an interrupted
setup. It keeps its non-secret provisioning settings in `cloudflare/remote.json`.

For an existing Worker, use `bunx tubeless remote connect` to discover deployments
with Tubeless Durable Objects, or pass its Studio URL directly. Connect with browser sign-in
through `cloudflared` or supply the existing Access service token via
`CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET`. Named remotes work from any
directory. See [named remotes](./cli.md#named-remotes).

## Set up Cloudflare manually

You need a Cloudflare account and a project with a `tubeless.project.ts`
(see the [project example](../examples/tubeless.project.ts)). From the project root:

```sh
tubeless init cloudflare
```

This writes `cloudflare/worker.ts`, `cloudflare.config.ts` and `vite.config.ts`
after loading your project, so a broken project fails here, not at deploy time. It
never overwrites files: if any of the three exists, or any other Vite config
(`vite.config.js`, `.mjs`, `.cjs`, `.mts`, `.cts`), it lists the conflicts and writes
nothing. Pass `-p <project-file>` when the project is not `./tubeless.project.ts`.
Then run the steps it prints:

```sh
bun add tubeless && bun add -d --exact cf@1.0.0-rc.6 vite@8.3.8 @cloudflare/vite-plugin@2.0.0-rc.3   # npm install -D -E … / pnpm add -D -E …
grep -qxF '.cloudflare/' .gitignore 2>/dev/null || printf '\n.cloudflare/\n' >> .gitignore   # cf build output and generated types
npx cf auth login
npx cf dev            # Studio on http://localhost:8787 (Access is skipped only on localhost)
npx cf deploy         # creates the Worker, Durable Objects and R2 bucket
```

- Deploying with the pinned Cloudflare CLI requires Node.js 22.23+, 24.22+, or 26.12+
  within those major versions.
- Use `--exact` (`-E` for npm and pnpm) to install the versions the repo verifies
  together.
- `cf` builds through Vite, hence `vite`, `@cloudflare/vite-plugin` and the generated
  `vite.config.ts`. If you already have a Vite config, rename it, run `init`, then
  replace the generated file with yours and add `cloudflare()` to its `plugins`.
- Keep `.cloudflare/` (generated types, Build Output) out of version control; the
  scaffold prints the `.gitignore` line but never edits the file.

The first deploy is not safe to open: until Access is configured, the Worker answers
every non-local request with `503 access_not_configured`. To finish:

1. In the dashboard, open Workers & Pages, your Worker, Settings, Domains & Routes,
   and choose **Enable Cloudflare Access**. Add a policy for the people who may use
   Studio. Access must cover every hostname that reaches the Worker, including the
   `workers.dev` URL the scaffold enables.
2. Copy the team domain (`<team>.cloudflareaccess.com`) and the **Application
   Audience (AUD) Tag** (Zero Trust, Access, Applications, your application,
   Additional settings).
3. Set both in `cloudflare.config.ts`, then run `npx cf deploy` again:

   ```ts
   ACCESS_TEAM_DOMAIN: bindings.text("your-team.cloudflareaccess.com"),
   ACCESS_AUD: bindings.text("<the AUD tag>"),
   ```

The binding names `TUBELESS_STUDIO`, `TUBELESS_RUN`, `TUBELESS_BUCKET`,
`ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` are fixed. The AUD tag is not a secret, but put
no credentials in `cloudflare.config.ts`. A working deployment root is
[`examples/cloudflare/`](../examples/cloudflare/).

## Launch from application code

When cron, a queue, or other trusted application code must submit a command, add a
handler to your Worker entry. Set an immutable `deploymentId` and change it whenever
execution code or configuration changes (browser-only apps can omit it).

```ts
import { createCloudflareApp } from "tubeless/cloudflare";
import project from "../tubeless.project.ts";

const app = createCloudflareApp(project, {
  deploymentId: "release-2026-11-16",
  recordInputs: { "validated-import": ["source"] },
});

export default {
  ...app.worker,
  async scheduled(event: { scheduledTime: number }, env: unknown): Promise<void> {
    const admission = await app.launch(
      env,
      "validated-import",
      { source: "daily.csv" },
      {
        idempotencyKey: `validated-import.daily.${event.scheduledTime}`,
        actor: { id: "daily-import", kind: "service" },
        trigger: "schedule",
      }
    );
    if (!admission.accepted) throw new Error(admission.errors.join("; "));
    console.log(`Admitted launch ${admission.launchId}`);
  },
};
export const { TubelessStudio, TubelessRun } = app.durableObjects;
```

See the [compiled scheduled Worker](../examples/cloudflare/scheduled-worker.ts). Your
application configures the cron or queue trigger and owns acknowledgements and
retries. Await `app.launch`; admission does not wait for the pipeline. Never expose
it as an unauthenticated HTTP route. `launch` takes the same parameters as Studio
(including `dryRun`, `stepIds`, `targets`, `maxConcurrency`) and validates them
before admission; pipeline schema validation happens during execution and can
produce a failed run.

- **Keys:** use one stable key per logical delivery (a cron occurrence's scheduled
  time, a queue message or business ID); a fresh random key per retry creates
  separate submissions. Keys and deployment IDs are 1-200 letters, digits, periods,
  underscores, colons or hyphens, and must hold no secrets.
- **Receipts:** `{ accepted: true, launchId }` is a durable admission receipt, not
  proof of start or success. After a thrown error, retry with the same key and
  unchanged intent to get the original receipt, never a second dispatch.
  `code: "invalid_launch"` means bad parameters; `code: "idempotency_conflict"`
  (changed intent or deployment under an existing key) carries the original
  `launchId`, which you should inspect before submitting new work.
- **Scope:** keys share one namespace per Studio object and never expire, surviving
  history clearing but not deletion of the Studio object's storage. Normalized intent
  (including defaults and deadline) must fit in 64 KiB.
- **Status:** `await app.getLaunch(env, launchId)` returns `commandId`, `state`
  (`starting`, `running`, `finished`, `failed`) and an optional `runId`, or
  `undefined`. Success or failure of a `finished` launch is on the run
  (`/?run=<runId>`); `failed` means the host closed it, possibly with no run.
  For the full execution status, use `app.getExecution(env, launchId)`.
  `app.cancelExecution(env, launchId)` persists a cancellation request and
  returns that execution's current state. Both return `undefined` for a missing ID.

### Attribution, input history, and Run again

- **Attribution:** Studio's run Details tab shows trigger and actor when known.
  Browser launches record `manual` plus the verified Access user or service-token
  client; headers and browser JSON cannot supply attribution, and localhost or older
  runs show none. Trusted `app.launch` callers pass `actor: { id, kind: "service",
  label? }` and `trigger: "schedule" | "queue" | "code" | "manual"` (default `code`).
  The first admission's attribution and inputs are kept on matching retries.
- **Input history:** no values are saved unless you allowlist them with
  `recordInputs: { [commandId]: [parameterKey, ...] }` on `createCloudflareApp`;
  unknown IDs or keys are configuration errors. Choose fields safe for everyone with
  Studio access. This is not secret detection. Execution jobs still hold full values
  temporarily, and your exporters keep their own policies.
- **Run again** opens the current command form with compatible saved fields filled
  in and unsaved ones blank. Fields whose type or choices changed are dropped with an
  explanation, a changed definition is flagged, and a removed command cannot be rerun.
  Submitting creates a fresh launch and key; it never replays the old admission.
- **Clear history** deletes launch metadata with events and refuses active launches;
  admission keys are preserved.

If a dispatch reply is lost, Studio reoffers the same job using the original launch
ID. The run object remembers accepted jobs and Studio grants permission to execute
once by default. A queued job from an older deployment fails before user code runs.
Use a new key only to deliberately request another run. To resume acknowledged
steps after an interruption, [enable Worker execution recovery](#recover-an-interrupted-worker-execution).

## Submit and follow from the CLI

Use the deployment ID from the scaffold's Worker version binding, or set an
immutable `deploymentId` on a custom `createCloudflareApp` entry.
Grant a [Cloudflare Access service token](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/)
access to the Worker through a **Service Auth** policy. Put its client ID and secret
in the calling process's `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET`
environment variables. The same Access trust domain covers Studio and this API.
For local development, an unconfigured Access binding permits the API on localhost
with a deployment ID. The CLI sends no credentials over HTTP.

```sh
# input.json contains command parameters, for example { "source": "daily.csv" }.
tubeless remote run validated-import --host https://studio.example.com \
  --input-file input.json --idempotency-key validated-import.manual.42 --detach --json
tubeless remote status <execution-id> --host https://studio.example.com --follow
tubeless remote cancel <execution-id> --host https://studio.example.com
```

`run` waits for a terminal state by default. `--detach` returns the durable
receipt `{"executionId":"…"}` with `--json`, or just the ID without it. The
execution ID is the `launchId` that trusted Worker code gets back from `app.launch`.
Use `status` for a snapshot or `status --follow` to stream retained and live logs
and progress. Output identifies the stage run and step attempt when available.
The CLI reconnects from the last event it processed. If you stop following with
Ctrl-C, use `status --follow` with the same execution ID to read retained output
from the beginning. Use `cancel` to request that remote execution stop. Older
Workers support status polling. The CLI uses the deployed
command catalog and can run from any directory. Use `--input-file -` for stdin;
omitting it submits `{}`. Include built-in controls such as `dryRun` in that
object. Both the submission and the normalized intent are bounded to 64 KiB.

For an uncertain submission, retry with the printed idempotency key, the same
host, command and inputs. A matching retry returns the original ID. Changed intent
or deployment conflicts. Studio links the execution to the root attempt once it
records a `runId`. Clearing history removes the trace and input metadata while
retaining the admission key and the saved execution outcome. Pending execution
values are kept in the dispatch record until the runner accepts the job or it closes.

| State                              | Meaning                                                                                                                         |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `queued`                           | Admitted. The runner has yet to claim execution.                                                                                |
| `running`                          | Runner granted permission to execute. `runId` appears when Studio records the root start.                                       |
| `completed`, `failed`, `cancelled` | Terminal outcome. A `reason` can explain host failures such as `deployment_unavailable` or `start_unconfirmed`.                 |
| `outcome_unknown`                  | The host closed the execution without a confirmed outcome. Check available history and external effects before launching again. |

If the execution is still running after `cancel`, `cancellationRequested: true`
acknowledges the request. Follow the execution to see whether it was cancelled or
finished first. Cancelling queued work fences the runner before it can claim it.

### HTTP API

Use `POST /api/executions/v1` with JSON `{ commandId, values, idempotencyKey }`.
A `202` response gives the `executionId`. A `409` conflict returns the original ID.
Use `GET /api/executions/v1/<executionId>` for status and
`POST /api/executions/v1/<executionId>/cancel` for cancellation. Both return the
status object with `executionId`, `commandId`, `state`, `cancellationRequested`,
and optional `runId`, `reason` and `target` (`"cloudflare"` or `"local"` with runner placement). An active cancellation request returns `202`.
Include `X-Tubeless-Execution: 1` on writes, and `Content-Type: application/json`
on submission. Requests with a browser `Origin` header must use the Worker's own
origin. The Worker verifies Access's signed assertion and derives launch attribution
from it.

A status read advertises `runFollowing: { "version": 1, "transport": "ndjson" }`
when the Worker supports `GET /api/executions/v1/<executionId>/events`. The route
uses the same Access checks as status. Each NDJSON record contains `version`,
`executionId`, a numeric `cursor`, `type`, and `payload`. The stream begins with a
`snapshot`. It can send `status`, `log`, `progress`, and `heartbeat` records before
a `terminal` snapshot. A `gap` with reason `history_unavailable` indicates that
history was removed or could not be recovered. The durable terminal status can
still be available.

An `end` record closes one response window. Reopen the stream with
`?cursor=<last-processed-cursor>` after `end` or a transport disconnect. Cursors
apply to the same execution. Omit the cursor to read from the beginning. Output
events advance the cursor. Status and boundary records carry the current cursor.

## Place work on a local Bun runner

A self-hosted deployment can run registered commands on its Cloudflare Worker or
on an enrolled Bun process. Configure placement on the Worker and submit through
the same `tubeless remote run`, Studio, or `app.launch` entry points.

1. Create a dedicated [Cloudflare Access service token](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/)
   and grant it a **Service Auth** policy on the Worker's Access app. Use its Client ID
   as `serviceId`. Keep its secret on the Bun machine as `CF_ACCESS_CLIENT_SECRET`
   and its ID as `CF_ACCESS_CLIENT_ID`. Use a different credential to submit jobs
   or open Studio.
2. Set an immutable `deploymentId` on the Worker. List the registered pipeline IDs
   owned by Bun in `localRunner.pipelines`. Each needs an explicit
   `implementationVersion`, shared schemas, and a matching definition in the Bun
   project. Update the deployment ID with any code or placement change and build
   both catalogs from the same release.

   ```ts
   const app = createCloudflareApp(project, {
     deploymentId: "release-42",
     localRunner: {
       serviceId: "your-runner-client-id.access",
       pipelines: ["normalize-on-bun"],
     },
   });
   ```

3. Start the runner from the Bun release. It connects outbound over HTTPS and runs
   one claim at a time. The runner project resolves its working directory relative
   to its project file.

   ```sh
   tubeless remote runner --host https://studio.example.com \
     --project ./runner.project.ts --deployment-id release-42
   ```

A top-level command listed in `localRunner.pipelines` waits for Bun. Other top-level
commands run on Cloudflare. A Worker-run pipeline can use `fromPipeline` to call a
listed child on Bun and consume the child's result in its next step. Set
`localRunner.workerChildren` to the registered, versioned Worker pipelines that
a Bun root can call through `fromPipeline`. Use disjoint lists. Unplaced children
run in their parent's runtime, and iteration and fan-out run in process.
Both project catalogs must define the child with the same identity. The
destination provides the real handler, and the other catalog can use a
placeholder that throws if invoked. Upgrade the runner CLI and both catalogs
together. Older runners leave these local launches queued.

For a runnable example, use [the Worker entry](../examples/cloudflare/runner-placement/worker.ts)
and [the Bun project](../examples/cloudflare/runner-placement/runner.project.ts).
Point the Cloudflare scaffold at that Worker entry, keep its `TUBELESS_BUCKET`
binding, set the runner's Access Client ID in `project.ts`, and upload an object
named `source.txt` to the bucket. Launch `fetch-transform-publish` with
`{"text":"source.txt"}` from the CLI. Cloudflare
reads the input object, Bun transforms it and writes `normalized.txt`, and
Cloudflare writes the returned value to `published.txt`. The shared project
factory supplies the same registered definitions in both environments. The
Worker's placeholder for the local transform fails if invoked directly, and its
imports never reach the filesystem implementation. The same example also
provides [a Bun root with a Worker child](#verify-the-bun-to-worker-round-trip).

The versioned stage handoff takes at most 64 KiB per request and per result.
It supports plain objects, dense arrays, strings, finite JSON numbers, booleans,
null, and a finalized void result. Values such as dates, bigints, nonfinite
numbers, negative zero, and nested `undefined` fail the transfer. The owning
pipeline validates its options and result before returning it. Dry-run controls,
the parent's remaining execution deadline, and cooperative cancellation cross
the handoff. Studio records the child's terminal event and result together.
If acknowledgement is lost, the runner can resend that completion without
running the child again. Author effectful steps with a safe `dryRun` handler or `dryRun: "skip"`.

Use `tubeless remote status <id>` to inspect a launch. A local root can stay
`queued` with `runner_waiting` while the runner is offline. `runner_incompatible`
means the offered definitions cannot claim it. Check the runner's project and
release. `deployment_unavailable` on a queued local launch identifies an older
revision that the current Worker cannot offer. A queued child remains part of
its running parent and can wait until the parent's deadline. Studio's run
details show the root runner and link stage runs under the parent step. Open the
stage to see its runner attempt, logs, and progress.

A lost active lease closes the attempt as interrupted. Without recovery, root
executions show `outcome_unknown` with `runner_interrupted` when no terminal
trace was confirmed. A waiting parent with recovery disabled fails if its child
loses the lease.

## Recover an interrupted Worker execution

Set `recoverInterruptedRuns: true` on `createCloudflareApp` to journal trusted
launches whose root runs on the Worker or on Bun. Use an immutable `deploymentId` and set
`implementationVersion` on the root and its child pipelines. Submit with the same
CLI, Studio, or `app.launch` entry points. Repeating a submission with the same
idempotency key and parameters returns the original execution ID.

```ts
const app = createCloudflareApp(project, {
  deploymentId: "release-42",
  recoverInterruptedRuns: true,
  localRunner: {
    serviceId: "your-runner-client-id.access",
    pipelines: ["normalize-on-bun"],
  },
});
```

After a Worker restart, Tubeless starts a fresh attempt under the same execution
ID and restores acknowledged step outputs. An explicit `fromPipeline` handoff
on Bun rejoins its original dispatch. If the stage result committed before the
reply was lost, the Worker uses that result and continues to the next step. Each
attempt shares the original Worker deadline. Studio's Launch panel links the
Worker attempts, and the original parent step links its Bun stage run.

If a claimed Bun stage loses its lease before acknowledging a result, or a Worker
effect has a saved intent without a completion, the execution stops at that step
with `outcome_unknown` and reason `journal_outcome_unknown`. Use the execution ID,
the failed step in Studio, and the stage dispatch ID in the Bun error to reconcile
external effects before submitting under a new key. Tubeless keeps downstream steps
blocked and honors a recorded cancellation after restart.

The journal accepts plain data with no shared or circular references,
including explicit `undefined` and negative zero. Each encoded binding or result
is limited to 64 KiB. The stage handoff retains its JSON value limits. Put effects
in step handlers and keep option mapping and finalizers free of effects because
orchestration can re-enter them. Dry runs skip the journal. See the
[execution journal contract](./execution-journal.md).

### Recover an interrupted Bun root

The same option enables recovery for commands placed on Bun. Deploy the Worker
and upgrade the Bun CLI together. A runner without journal support leaves
recoverable roots queued and reports that it needs an upgrade.

Studio preserves the launch inputs and journal while the execution is open.
After losing a lease, Tubeless queues another attempt with the original deadline.
Restart the enrolled runner with the same project directory, deployment ID, and
compatible implementations. Studio links the attempts under the original
execution ID. Acknowledged steps restore their results. An ordinary effect with
recorded intent and no committed result surfaces `outcome_unknown` and leaves its
dependents blocked. Cancelling a queued recovery prevents another claim.

Keep the runner credential on the machine that owns the project's local data.
Step outputs can reference files, so a replacement must also have the required
files and environment in its working directory. The Studio journal stores the
encoded step values until terminal settlement. Recovery for a Bun root uses
its own journal. A Bun root rejoins an already dispatched Worker child under
the same stage ID. A committed stage result survives the loss of its completion
reply. The stage stays linked to the original parent attempt, and Studio links
the resumed attempt under the same execution ID. If the Worker stops after an
effect and before committing its result, the launch reports `outcome_unknown`
with reason `journal_outcome_unknown` and dependent steps stay blocked.

### Smoke test a deployed Worker and Bun runner

1. Deploy the [mixed-runner example](../examples/cloudflare/runner-placement/worker.ts)
   with its `TUBELESS_BUCKET` binding and the Access setup above. Upload unique
   text to `source.txt` in that bucket. Use the same release for the Worker and Bun.
2. Start `tubeless remote runner` on the Bun machine with the dedicated runner
   credential. Use the separate launch credential in the shell below. Give the
   smoke test a fresh key, and keep `input.json` containing `{"text":"source.txt"}`.

   ```sh
   tubeless remote run fetch-transform-publish --host https://studio.example.com \
     --input-file input.json --idempotency-key recovery-smoke.42 --detach --json
   tubeless remote status <execution-id> --host https://studio.example.com --follow
   ```

   Look for the Bun child's log and progress. Press Ctrl-C and follow the same
   execution ID again to confirm that retained output is available and the run
   continues.

3. After the Bun stage completes, restart the runner with the same release. Confirm
   `status` reaches `completed`, `published.txt` in R2 contains the normalized text,
   and `normalize-writes.ndjson` beside the Bun project contains one entry for that
   input. Repeat `remote run` with the same key and confirm it returns the same
   execution ID without adding an entry.

### Verify the Bun-to-Worker round trip

1. Use the same [Worker entry](../examples/cloudflare/runner-placement/worker.ts)
   and [Bun project](../examples/cloudflare/runner-placement/runner.project.ts).
   The Worker config places `local-file-via-worker` on Bun and allowlists
   `prefix-on-worker` in `localRunner.workerChildren`. Redeploy and restart the
   enrolled runner from the same revision with `recoverInterruptedRuns` enabled.
2. Upload `prefix.txt` to the Worker's `TUBELESS_BUCKET`. Put
   `local-source.txt` beside the Bun project file. From the launch shell, submit
   with a fresh key and an input file containing `{"text":"local-source.txt"}`.

   ```sh
   tubeless remote run local-file-via-worker --host https://studio.example.com \
     --input-file input.json --idempotency-key round-trip.42 --detach --json
   tubeless remote status <execution-id> --host https://studio.example.com --follow
   ```

   You can also configure the Worker's cron trigger to run the same command.
   The trigger logs the execution ID and uses the scheduled time as its
   idempotency key.

3. Confirm `completed` and check that `local-result.txt` on Bun matches
   `worker-result.txt` in the bucket. In Studio, open the execution ID, then open
   the child run under `prefix-in-cloudflare`. The root shows the local runner
   and the linked stage logs the Cloudflare attempt.
4. Submit with a fresh key and `"dryRun": true` in the same input object. The
   Worker reads the prefix and the run completes without updating either result
   file. To request cancellation for an active run, use
   `tubeless remote cancel <execution-id> --host https://studio.example.com`.
   Worker handlers receive the cancellation through their step signal.

The workerd tests fault both handoff directions. They restart the hosts after a
committed result loses its reply and after an effect leaves no committed result.

## Application trace exporters

Cloudflare runs honor the project's `tracing.exporters` factory ([CLI guide](./cli.md#run)).
To use Worker bindings, add a factory on the app:

```ts
const app = createCloudflareApp<Env>(project, {
  tracing: {
    exporters: ({ env, pipelineId, launchId, signal }) => [
      createTelemetryExporter({ token: env.TELEMETRY_TOKEN, pipelineId, launchId, signal }),
    ],
    onExporterError: (error) => console.warn("Trace delivery failed", error),
  },
});
```

`Env` is your bindings type and `createTelemetryExporter` returns a
`PipelineTraceExporter`. Factories run once per launch (nested runs share them) and
compose with Studio ingestion: an app exporter failure neither removes Studio history
nor fails the pipeline, but Studio ingestion failures still stop the run.

- A factory error fails the launch before execution; release unreturned resources
  when the factory `signal` aborts.
- Each `export` or `flush` is awaited up to five seconds (capped by the remaining run
  budget), then that destination is retired. The timeout cannot cancel your I/O, so
  exporters own network deadlines and cleanup. Put required delivery in `export` or
  `flush`; error handlers do not delay alarm completion.

## Opt-in agent transcripts

History records structure only by default. To retain agent content, set each agent's
`transcript` option with `createCloudflareAgentTranscriptWriter` from
`tubeless/cloudflare/transcript` (it also loads in Node). Resolve the Studio binding
lazily and keep it server-side:

```ts
import { env } from "cloudflare:workers";
import { createCloudflareAgentTranscriptWriter } from "tubeless/cloudflare/transcript";

const transcript = createCloudflareAgentTranscriptWriter(() =>
  env.TUBELESS_STUDIO.getByName("default")
);
// Supply { ...transcript, redact, maxBytes } as your agent's transcript option.
```

Adapt the [agent recipe](../examples/agent-transcript-cloudflare.ts). Child agents need
their own opt-in, and redaction and byte budgets apply before delivery. A delivery
failure disables capture for that invocation without failing the agent, and an
abruptly terminated host can leave a partial recording. Content shows in Studio's
Transcript tab behind the same Access checks as history, so every admitted user can
read it. **Clear history** deletes structure and transcripts together and refuses
while launches are active; nothing expires automatically.

## Run limits

**A Worker attempt executes inside a Durable Object alarm with a 15-minute
wall-time limit.** Tubeless budgets up to 14 minutes for the execution. Set a
shorter limit with `createCloudflareApp(project, { limits: { maxRunDurationMs } })`
(at most 840,000 ms). The budget starts with the first attempt on either runner.

- **CPU:** 30 seconds by default; Workers Paid allows up to 5 minutes via
  `limits: { cpuMs: 300_000 }` in `cloudflare.config.ts` (commented out in the
  scaffold). I/O waits do not count. Use Workers Paid for real pipelines.
- **Recorded text:** log, progress, skip and error text beyond 65,536 characters is
  truncated in history (Durable Object row limit); local history keeps it all.
- **Crash recovery:** opt in with `recoverInterruptedRuns`. Attempts share the
  original execution deadline.

To fit the limit, keep heavy steps short and split work across steps and fan-out
items; put a long single step behind [`fromRemote`](./remote-step-composition.md); or
use a host engine for multi-hour workflows: [Temporal](./temporal.md),
[Inngest](./inngest.md) or [AWS Step Functions](./step-functions.md).

## Using bindings in handlers

Handlers run in the Worker and read bindings from `cloudflare:workers`, for example
`env.TUBELESS_BUCKET.put(`reports/${context.runId}.json`, body)` inside a step with
`dryRun: "skip"`. Import it only from code that deploys to Workers; keep it behind a
small adapter in modules that also run through the local CLI. Use your own R2 prefix
alongside the cache's `tubeless-cache/`. `node:fs` writes only under `/tmp`, so
nothing durable goes on the filesystem.

## Code-mode agents on Workers

[Code mode](./agents.md#code-mode) needs an executor, and Workers have no worker
threads, so use a Worker Loader executor. Each script runs in a fresh
[Dynamic Worker](https://developers.cloudflare.com/dynamic-workers/) with no `env`,
no outbound network (`globalOutbound: null`) and a CPU budget; tool calls return to
your Worker over RPC, so credentials stay with the host. Add a `worker_loaders`
binding, for example `LOADER: bindings.workerLoader()` in `cloudflare.config.ts`:

```ts
import { env } from "cloudflare:workers";
import { defineAgent } from "tubeless/agent";
import { openaiModel } from "tubeless/agent/openai";
import { createWorkerLoaderCodemodeExecutor } from "tubeless/cloudflare";

const agent = defineAgent({
  id: "triage",
  model: openaiModel(),
  environment: workspace, // an explicit environment: Workers have no local workspace
  tools: { lookup },
  codemode: { executor: createWorkerLoaderCodemodeExecutor(env.LOADER, { cpuMs: 30_000 }) },
});
```

`cpuMs` defaults to 30,000 per script. A Dynamic Worker cannot be terminated from the
host: at the 60-second script deadline or on cancellation, Tubeless stops waiting and
rejects later tool calls, and the CPU budget bounds anything still running. Miniflare
does not enforce Dynamic Worker CPU limits, so a runaway script also blocks local
development.

## Caching on Workers

The default cache store writes files and the default codec uses `v8.serialize`;
neither works on Workers, so a cached step with no explicit store fails. Give each
cached step an R2 store and the JSON codec from `tubeless/cloudflare/cache` (it loads
anywhere; `tubeless/cloudflare` loads only in workerd, and your steps also load in
Node). Keep the bucket in a small module and bind it from the Worker entry:

```ts
// r2-cache.ts
import { createR2CacheStore, jsonCacheCodec, type R2BucketLike } from "tubeless/cloudflare/cache";

let bucket: R2BucketLike | undefined;

export function bindCacheBucket(value: R2BucketLike): void {
  bucket = value;
}

export const r2Cache = {
  store: createR2CacheStore(() => {
    if (!bucket) throw new Error("Bind the R2 cache bucket in cloudflare/worker.ts first.");
    return bucket;
  }),
  codec: jsonCacheCodec,
};
```

```ts
// A pipeline module: cache: { version: "v1", ...r2Cache }
// cloudflare/worker.ts
import { env } from "cloudflare:workers";
import { createCloudflareApp } from "tubeless/cloudflare";
import { bindCacheBucket } from "../r2-cache.ts";
import project from "../tubeless.project.ts";

bindCacheBucket(env.TUBELESS_BUCKET);
const app = createCloudflareApp(project);

export default app.worker;
export const { TubelessStudio, TubelessRun } = app.durableObjects;
```

Locally nothing binds the bucket, so these steps fail in Node: bind another
`R2BucketLike` or use a different store for local runs. Entries live under
`tubeless-cache/` unless you pass `createR2CacheStore(bucket, { prefix })`.
`jsonCacheCodec` rejects values that would not round-trip (dates, maps, class
instances, `undefined`, `NaN`, sparse arrays, shared or circular references), so
return plain data or supply your own codec. See
[step output caching](./step-output-cache.md) for versions, keys and `maxAge`.

## Security model

- The Worker verifies the `Cf-Access-Jwt-Assertion` token on every request (RS256
  signature, issuer, audience, expiry, not-before); identity headers alone are never
  trusted. Durable Objects are not publicly routable.
- Mutating requests need a same-origin `Origin` header, else `untrusted_origin`.
- There is no per-user isolation or audit trail.
- Without Access configuration the Worker serves Studio only on `localhost`,
  `127.0.0.1` and `[::1]`; elsewhere it returns `503 access_not_configured` (or
  `503 access_misconfigured` if only one Access value is set).

Your project registers the commands Studio can launch, so deploy a catalog meant for
this environment, without seeding or local filesystem commands
([hosting contract](./studio.md#host-studio-behind-an-application-gateway)). There is
no built-in scheduler; use [application launches](#launch-from-application-code) and,
for durable retries or long waits, a [host engine](#run-limits).

## Troubleshooting

| Symptom                                                                                                    | Cause and fix                                                                                                                                                                              |
| ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `503 access_not_configured` / `access_misconfigured`                                                       | Both or one of `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` is missing, or the team domain is not `<team>.cloudflareaccess.com`. Fix `cloudflare.config.ts`, redeploy.                            |
| 401, or 403 (`access_denied`)                                                                              | Access does not cover this hostname (check Domains & Routes, including `workers.dev`), or the token's issuer or audience does not match `ACCESS_AUD`, or your policy excludes you.         |
| "did not record a start within 30 seconds" / "could not confirm"                                           | The launch was not acknowledged. Check history before launching again; the run may still appear.                                                                                           |
| Run failed with `TUBELESS_RUN_CANCELLED` and a host-stop message                                           | The platform stopped the run object, for example at the time limit. See [Run limits](#run-limits).                                                                                         |
| A cached step fails                                                                                        | It uses the default file store or V8 codec, or no R2 bucket was bound. See [Caching on Workers](#caching-on-workers).                                                                      |
| Local commands fail to load the project (`ERR_UNSUPPORTED_ESM_URL_SCHEME`, `cloudflare:workers` not found) | A loaded module imports `tubeless/cloudflare` or `cloudflare:workers`. Import cache helpers from `tubeless/cloudflare/cache`; keep `cloudflare:workers` in the Worker entry or an adapter. |
| `No Cloudflare dev-server is installed`                                                                    | `package.json` lacks `@cloudflare/vite-plugin`. Run the install step `tubeless init cloudflare` prints.                                                                                    |
| `Cannot resolve entry module index.html`                                                                   | `vite.config.ts` is missing or does not register `cloudflare()`. Restore it from the [example](../examples/cloudflare/vite.config.ts).                                                     |
