# Deploy to Cloudflare

Run Studio and your pipelines in your own Cloudflare account. `tubeless init cloudflare`
scaffolds a Worker that serves Studio behind Cloudflare Access, launches commands
from your project, and keeps history in Durable Objects.

```text
Browser → Cloudflare Access → Worker → TubelessStudio (history, launches)
                                     → TubelessRun (one object per run)
                                     → R2 bucket (cache entries, your artifacts)
```

## What you get

- One Worker, two SQLite-backed Durable Objects (`TubelessStudio` and `TubelessRun`),
  and one R2 bucket.
- Studio with launch forms, live progress, logs, the run graph, cancel and history,
  for every command in your project.
- A single trust domain for your team. Everyone Cloudflare Access admits can see all
  history and launch every command.

Pipelines run in the Worker runtime, so handlers must work on Workers. Read
[Run limits](#run-limits) before you deploy anything long-running.

## Five-minute deploy

You need a Cloudflare account and a project with a `tubeless.project.ts`
(see the [project example](../examples/tubeless.project.ts)). From the project root:

```sh
tubeless init cloudflare
```

This writes `cloudflare/worker.ts`, `cloudflare.config.ts` and `vite.config.ts`. It
loads your project and derives every command first, so a broken project fails here
and not at deploy time. It never overwrites existing files: if any of the three
already exists, or any other Vite config file (`vite.config.js`, `.mjs`, `.cjs`,
`.mts`, `.cts`), it names the conflicts and writes nothing. Pass `-p <project-file>`
when the project is not `./tubeless.project.ts`. Then run the steps it prints:

```sh
bun add tubeless && bun add -d --exact cf@1.0.0-beta.32 vite@8.3.8 @cloudflare/vite-plugin@2.0.0-beta.v.17   # npm install -D -E … / pnpm add -D -E …
grep -qxF '.cloudflare/' .gitignore 2>/dev/null || printf '\n.cloudflare/\n' >> .gitignore   # cf build output and generated types
npx cf auth login
npx cf dev            # Studio on http://localhost:8787 (Access is skipped only on localhost)
npx cf deploy         # creates the Worker, Durable Objects and R2 bucket
```

Deploying needs Node 22.12 or later: `cf` requires Node 22 and Vite 8 requires 22.12.
`init` warns when it runs on an older Node. `cf` is the Cloudflare configuration CLI
and is in beta. `cf dev`, `cf build` and
`cf deploy` build the Worker through Vite, so the project needs `vite`,
`@cloudflare/vite-plugin` and the `vite.config.ts` that registers the plugin. The
scaffold pins all three packages to versions verified together, plus the
compatibility date (`2026-10-01`, with `nodejs_compat`). Install those exact
versions with `--exact` (or `-E` for npm and pnpm): package managers save `^` ranges by
default, and a range can later resolve to an untested beta release.

The Vite plugin writes generated types to `.cloudflare/types/`, and `cf build` (the
first step of `cf deploy`) writes the Build Output to `.cloudflare/output/`. Keep
`.cloudflare/` out of version control; the scaffold prints the line to add but never
edits your `.gitignore`.

If the project already has a Vite config (`vite.config.ts` or any other supported
name), `init` names it as a conflict and writes nothing, because Vite loads only one
config file. Rename yours for the moment, run `init`, then replace the generated
`vite.config.ts` with yours and add `cloudflare()` to its existing `plugins` array:

```diff
+import { cloudflare } from "@cloudflare/vite-plugin";
-  plugins: [react()],
+  plugins: [react(), cloudflare()],
```

The first deploy is not safe to open yet: until Access is configured, the Worker
answers every non-local request with `503 access_not_configured`. To finish:

1. In the dashboard, open Workers & Pages, your Worker, Settings, Domains & Routes,
   and choose **Enable Cloudflare Access**. Add a policy for the people who may use
   Studio. Access must cover every hostname that reaches the Worker, including the
   `workers.dev` URL the scaffold enables.
2. Copy the team domain (`<team>.cloudflareaccess.com`) and the application
   audience tag. Find the tag under Zero Trust, Access, Applications, your
   application, Additional settings, **Application Audience (AUD) Tag**.
3. Set both in `cloudflare.config.ts`:

   ```ts
   ACCESS_TEAM_DOMAIN: bindings.text("your-team.cloudflareaccess.com"),
   ACCESS_AUD: bindings.text("<the AUD tag>"),
   ```

4. Run `npx cf deploy` again.

The names `TUBELESS_STUDIO`, `TUBELESS_RUN`, `TUBELESS_BUCKET`, `ACCESS_TEAM_DOMAIN`
and `ACCESS_AUD` are fixed; keep them as the scaffold writes them. The AUD tag is
not a secret, but do not put credentials in these text bindings or anywhere else in
`cloudflare.config.ts`.

For a working deployment root, see [`examples/cloudflare/`](../examples/cloudflare/).
It deploys the shared [example project](../examples/tubeless.project.ts).

## Launch from application code

After scaffolding, add a handler to your Worker entry when cron, a queue, or another
trusted part of your application needs to submit a command. Set an immutable
`deploymentId` on `createCloudflareApp` and change it whenever execution code or
configuration changes. Existing browser-only apps can omit it.

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

Adapt the [compiled scheduled Worker example](../examples/cloudflare/scheduled-worker.ts).
The application configures its Cloudflare cron trigger or queue binding and owns
delivery acknowledgements and retries. Await `app.launch`; admission does not wait
for the pipeline to finish. Do not expose this trusted code capability as an
unauthenticated HTTP route. Studio's browser routes retain Access and Origin checks.

### Receipts, retries, and deployment changes

`launch` accepts registered command IDs and the same structured parameter values
as Studio, including `dryRun`, `stepIds`, `targets`, and `maxConcurrency`. It validates
the command parameters before admission; pipeline domain-schema validation still
happens during execution and can produce a failed recorded run.

Choose a stable key for one logical delivery: a named cron occurrence's scheduled
timestamp, or a queue's stable message/business ID. Keys and deployment IDs contain
1–200 letters, digits, periods, underscores, colons, or hyphens. Do not put secrets
in either identifier. A new random key on every retry creates different submissions.

- `{ accepted: true, launchId }` is an immutable receipt for durable admission. It
  confirms neither a recorded start nor successful execution.
- Retry a thrown transport/storage error with the same key and unchanged intent.
  Matching retries return the original receipt, including after completion or a
  Durable Object restart. They never dispatch another execution.
- `accepted: false` with `code: "invalid_launch"` reports invalid command parameters
  or configuration. `code: "idempotency_conflict"` includes the original `launchId`;
  investigate that launch before deliberately submitting new work.

Keys share one namespace across all commands and deployments using the same Studio
object/binding. Intent comparison includes the project, command, normalized
parameters and controls (including defaults), cooperative deadline, and deployment
ID. Object property order does not matter; array order does. Parameter strings and
arrays use Studio's existing bounds; normalized intent must also fit within 64 KiB.
Changing intent or deployment under an existing key conflicts. Keys never expire
automatically and survive history clearing, including after a terminal launch.
Deleting the Studio object's storage also deletes these guarantees.

Use `await app.getLaunch(env, launchId)` to read `commandId`, `state`, and an optional
`runId`. Missing launches return `undefined`. State `starting` means no root start
has been recorded; `running` means one has; `finished` means a root completion was
recorded, whose actual success/failure/cancellation is in the linked run. State
`failed` means the host closed the launch and can occur without a run ID. Open the
linked run in Studio with `/?run=<runId>`.

An unconfirmed dispatch is never automatically executed again. If admission
commits but the host stops before dispatch, reconciliation eventually marks that
same launch failed; replay does not start it. A queued job from an older deployment
is also refused before user code runs. Inspect the original launch, then use a
new key only when deliberately requesting another run. This is submission
deduplication, not crash resume or business-side-effect idempotency.

### Attribution, input history, and Run again

Studio's run Details tab shows the command, launch, deployment and definition IDs,
trigger, and actor when available. Browser launches use `manual` and the verified
Cloudflare Access JWT's user ID and email, or service-token client ID. Unconfigured
localhost sessions and older runs have no verified actor; Studio labels missing
metadata explicitly. Identity headers and browser JSON cannot supply attribution.
Trusted `app.launch` callers can supply `actor: { id, kind: "service", label? }` and
`trigger: "schedule" | "queue" | "code" | "manual"`; the trigger defaults to `code`.
Attribution is recorded on first admission. Matching retries keep the original
actor, trigger and input history, even if the retry supplies different attribution.

Input values are **not saved in launch history by default**. To retain selected
fields, configure `recordInputs: { [commandId]: [parameterKey, ...] }` on
`createCloudflareApp`. Unknown command IDs or parameter keys are configuration
errors. Choose only fields suitable for everyone with Studio access; this is an
allowlist, not automatic secret detection or redaction. Saved values are normalized
command parameters, including defaults. Non-allowlisted values never enter launch
metadata. Omitted fields are listed by name; allowed fields distinguish an absent
value from `""`, `[]`, `false`, and `0`. Execution jobs still temporarily hold their
full input values, and application logging/exporters retain their own policies.

**Run again** opens the current command's launch form for review. It fills only
compatible saved fields, leaves unsaved values blank, and asks for missing required
inputs. Removed fields and changed types, choices or numeric constraints are
discarded with an explanation. A changed or unavailable definition identity is
shown before submission; a removed command cannot be rerun. Current command and
domain-schema validation still apply. Submission creates a fresh key and launch;
it never replays the old admission or automatically executes when the form opens.

Clear history deletes launch metadata and events together and refuses active
launches. It preserves launch/admission bookkeeping and deduplication keys. Clearing
history does not recreate metadata when an old key is retried.

## Application trace exporters

Cloudflare runs honor the project's `tracing.exporters` factory described in the
[CLI guide](./cli.md#run). To use Worker bindings, add another factory on the app:

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

`Env` is your application's bindings type and `createTelemetryExporter` is your
adapter returning a `PipelineTraceExporter`. The factory receives the run Durable
Object's bindings after Studio admits the launch. It also receives `cwd` (`/tmp`)
and the run's abort signal. Project and app factories run once per launch; nested
runs share their exporters. Both sets compose with Studio ingestion, so an app
exporter failure does not remove Studio history or fail the pipeline. Studio
ingestion failures still stop the run under the existing delivery policy.

Factory errors fail the launch before pipeline execution. If a later factory or
command preparation fails, Tubeless aborts the factory signal and attempts to
flush previously returned exporters without replacing the original failure.
Factories must release any resources they have not returned when that signal
aborts. Normal runs retain the pipeline runtime's ordinary flushing.

Cloudflare waits up to
five seconds for each application `export` or `flush`, capped by the remaining run
budget. A timed-out destination is retired so Studio ingestion and healthy
exporters can finish. This applies to both project and app exporters. Studio's
own ingestion keeps its existing retry and failure policy.

A timeout stops Tubeless waiting; it cannot forcibly cancel application I/O.
Exporters still own network deadlines and resource cleanup, including flush
requests after cancellation. Project and app error handlers run independently;
throwing or rejecting in one cannot suppress the other. Their promises are observed
for rejection but do not delay alarm completion. Put required delivery in an
exporter's `export` or `flush`.

## Opt-in agent transcripts

History records structure by default. To retain agent content, configure each
agent's `transcript` option with `createCloudflareAgentTranscriptWriter` from
`tubeless/cloudflare/transcript`. This entry also loads in Node, so shared project
modules can import it. Resolve the Studio binding lazily in the Worker; keep the
binding and its RPC capability on the server:

```ts
import { env } from "cloudflare:workers";
import { createCloudflareAgentTranscriptWriter } from "tubeless/cloudflare/transcript";

const transcript = createCloudflareAgentTranscriptWriter(() =>
  env.TUBELESS_STUDIO.getByName("default")
);
// Supply { ...transcript, redact, maxBytes } as your agent's transcript option.
```

Adapt the [credential-free agent recipe](../examples/agent-transcript-cloudflare.ts)
and register its returned agent in your Worker project. Child agents require their
own opt-in. Redaction and the usual per-record/per-invocation byte budgets apply
before delivery. The writer makes at most five delivery attempts within five
seconds; it handles buffered structural starts and lost acknowledgements without
duplicating content. Delivery failure disables capture for that invocation without
failing the agent. An abruptly terminated host can leave a partial recording.

The Studio Durable Object stores content separately from trace events and recovery
state, and exposes it in the live Transcript tab behind the same Cloudflare Access
checks as history. All admitted users can read the deployment's captured content.
No new binding or storage credential is required. Tables are created on the first
accepted write; old history remains readable without transcript content.

**Clear history** deletes structural events and transcript content in one transaction
and refuses while launches are active, including launches still starting. Closed
launch receipts remain to prevent late event retries from recreating deleted history.
Late content for a deleted run is refused. This does not add automatic expiry or
delete application-owned artifacts in R2.

## Run limits

**A run executes inside one Durable Object alarm, so it has at most 15 minutes of
wall time.** Tubeless aborts the run at 14 minutes so it can record its own failure
before Cloudflare stops the invocation. Pass a shorter limit with
`createCloudflareApp(project, { limits: { maxRunDurationMs } })`; the value cannot
exceed 840,000 ms.

Waiting for a launch to start does not consume its execution limit. Studio
reconciles an unfinished run from its recorded root start plus the execution
limit and a two-minute reporting grace period. Launches without a recorded start
use their creation time instead.

On this target, log lines, progress messages, skip messages, and error messages or
stacks longer than 65,536 characters are truncated in recorded history because
Durable Object storage limits row size. Local history keeps the full text.

CPU time is limited too: 30 seconds by default, and up to 5 minutes on Workers Paid
through `limits: { cpuMs: 300_000 }` in `cloudflare.config.ts` (the scaffold has
this line commented out). Time spent waiting on I/O does not count as CPU. Use
Workers Paid for real pipelines; the free plan allows far less CPU.

You cannot raise the 15-minute wall limit by configuration. There is no crash
resume either: a run that is cut off is recorded as failed. To fit the limit:

- Keep each heavy step short, and split work across steps and fan-out items.
- Move a long single step behind [`fromRemote`](./remote-step-composition.md) so
  another service does the work and the Worker only waits on it.
- Use a host engine for multi-hour workflows: [Temporal](./temporal.md),
  [Inngest](./inngest.md) or [AWS Step Functions](./step-functions.md).

A future release may add an executor backed by Cloudflare Workflows for long-running
orchestration. It would save explicit execution checkpoints with defined retry
behavior; the step cache is not a resume mechanism. Adopting it may require new
bindings or scaffold changes. That is a direction, not a feature of this version,
and it carries no date.

## Using bindings in handlers

Handlers run in the Worker, so they can read bindings from the Workers environment:

```ts
import { env } from "cloudflare:workers";

const saveReport = step("save-report", {
  description: "Store the report in R2.",
  dependsOn: [buildReport],
  dryRun: "skip",
  run: async ({ buildReport }, context) => {
    await env.TUBELESS_BUCKET.put(`reports/${context.runId}.json`, JSON.stringify(buildReport));
  },
});
```

Import `cloudflare:workers` only from handler code that deploys to Workers. Pipeline
modules that also run through the local CLI should keep that import behind a small
adapter. R2 artifacts use `env.TUBELESS_BUCKET`; add your own prefix next to
`tubeless-cache/`, which the cache store uses. Other bindings you add to
`cloudflare.config.ts` are available the same way.

Handlers cannot use the filesystem for anything durable: `node:fs` writes only
under `/tmp`.

## Code-mode agents on Workers

[Code mode](./agents.md#code-mode) runs agent scripts in an executor. Workers have no
worker threads, so give agents a Worker Loader executor. Each script then runs in a
fresh [Dynamic Worker](https://developers.cloudflare.com/dynamic-workers/) with no
`env`, no outbound network (`globalOutbound: null`) and a CPU budget. Tool calls come
back to your Worker over RPC, so credentials and bindings stay with the host. Add a
`worker_loaders` binding, for example `LOADER: bindings.workerLoader()` in
`cloudflare.config.ts` or `[[worker_loaders]] binding = "LOADER"` with Wrangler:

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
rejects the script's later tool calls, and the CPU budget bounds work that keeps
running. Syntax errors are reported with their line, as on Node. Miniflare does not
enforce Dynamic Worker CPU limits, so a runaway script also blocks local development.

## Caching on Workers

The default cache store writes files and the default codec uses `v8.serialize`.
Neither works on Workers, so a cached step with no explicit store fails. Give each
cached step an R2 store and the JSON codec.

Import them from `tubeless/cloudflare/cache`, which loads anywhere.
`tubeless/cloudflare` loads only in workerd, and your step definitions also load in
Node whenever `tubeless init cloudflare`, `tubeless run`, `tubeless ui` or your tests
import the project. Keep the bucket in a small module and bind it from the Worker
entry:

```ts
// r2-cache.ts
import { createR2CacheStore, jsonCacheCodec, type R2BucketLike } from "tubeless/cloudflare/cache";

let bucket: R2BucketLike | undefined;

export function bindCacheBucket(value: R2BucketLike): void {
  bucket = value;
}

export const r2Cache = {
  store: createR2CacheStore(() => {
    if (!bucket) {
      throw new Error(
        "Bind the R2 cache bucket in cloudflare/worker.ts before running cached steps."
      );
    }
    return bucket;
  }),
  codec: jsonCacheCodec,
};
```

```ts
// In a pipeline module
const load = step("load", {
  cache: { version: "v1", ...r2Cache },
  run: async () => fetchRows(),
});
```

```ts
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

The store calls the getter on every read and write. Locally nothing binds the
bucket, so these cached steps fail when they run in Node. For local runs, bind
another `R2BucketLike` or give those steps a different cache store.

`createR2CacheStore(bucket, { prefix })` accepts a bucket or a getter and keeps
entries under `tubeless-cache/` unless you pass another prefix. `jsonCacheCodec`
rejects values that would not come back identical: dates, maps, class instances,
`undefined`, `NaN`, infinities, `-0`, sparse arrays, shared or circular references,
and objects without the standard prototype. Return plain data from cached steps, or
supply your own reconstructing codec. See
[step output caching](./step-output-cache.md) for versions, keys and `maxAge`.

## Security model

- The Worker verifies the `Cf-Access-Jwt-Assertion` token on every request: RS256
  signature against your team's keys, plus issuer, audience, expiry and not-before.
  Keys are cached for at most one hour, and fetching them times out after five
  seconds. Identity headers alone are never trusted.
- The Durable Objects are not publicly routable. Only the Worker reaches them, after
  the Access check.
- Mutating requests need a same-origin `Origin` header; others fail with
  `untrusted_origin`.
- Every user Access admits sees all history and can launch every command. There is
  no per-user isolation or audit trail.
- Clearing history is disabled.
- Without Access configuration, the Worker serves Studio only on `localhost`,
  `127.0.0.1` and `[::1]`, so `cf dev` works. Elsewhere it returns
  `503 access_not_configured`. If only one of the two Access values is set, it
  returns `503 access_misconfigured`.

Your project registers the commands Studio can launch. Deploy a catalog meant for
this environment, not one with seeding or local filesystem commands. See the
[Studio hosting contract](./studio.md#host-studio-behind-an-application-gateway)
for the model this builds on.

## What it is not

This version has no crash resume, built-in scheduler, multi-tenant isolation or
per-user audit trail. It runs one project for one team. Application-owned cron and
queue handlers can [submit commands](#launch-from-application-code); use a
[host engine](#run-limits) when execution itself needs durable retries or long waits.

## Troubleshooting

| Symptom                                                                                                      | Cause and fix                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `503 access_not_configured`                                                                                  | `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` are both empty. Enable Access, set both, and redeploy.                                                                                                                                        |
| `503 access_misconfigured`                                                                                   | Only one is set, or the team domain is not `<team>.cloudflareaccess.com`. Fix `cloudflare.config.ts` and redeploy.                                                                                                                  |
| `503 studio_unavailable`, or a plain 503 "Studio is temporarily unavailable" page                            | The Worker could not reach the Studio Durable Object. Retry; if it persists, check the Worker logs and that `TUBELESS_STUDIO` is bound as the scaffold wrote it.                                                                    |
| API calls return 401, or pages show a plain 403 "Access sign-in is required" page                            | No valid Access token reached the Worker. Access is not enabled on the hostname you are using. It must cover every hostname that reaches the Worker, including the `workers.dev` URL the scaffold enables (check Domains & Routes). |
| 403 `access_denied`, or a plain 403 "Access denied this request" page                                        | The token is valid but its issuer or audience does not match, or your Access policy does not include you. Compare `ACCESS_AUD` with the application's AUD tag.                                                                      |
| "did not record a start within 30 seconds… may still start" or "could not confirm the run started"           | The launch was not acknowledged. Check history before launching again; the run may still appear.                                                                                                                                    |
| Run shows failed with `TUBELESS_RUN_CANCELLED` and a host-stop message                                       | The platform stopped the run object before it finished, for example at the time limit. See [Run limits](#run-limits). The run object or Studio records the failure.                                                                 |
| A cached step fails                                                                                          | It uses the default file store or V8 codec, or nothing bound the R2 bucket. Use the [R2 cache pattern](#caching-on-workers) and call `bindCacheBucket` in `cloudflare/worker.ts`.                                                   |
| Local commands fail to load the project (`ERR_UNSUPPORTED_ESM_URL_SCHEME` or `cloudflare:workers` not found) | A module the project loads imports `tubeless/cloudflare` or `cloudflare:workers`. Import cache helpers from `tubeless/cloudflare/cache`, and keep `cloudflare:workers` in `cloudflare/worker.ts` or behind an adapter.              |
| `untrusted_origin` on launch or cancel                                                                       | The request's `Origin` does not match the page. Use the deployed hostname directly, without a proxy that rewrites it.                                                                                                               |
| `No Cloudflare dev-server is installed` from `cf dev`, `cf build` or `cf deploy`                             | `package.json` does not declare `@cloudflare/vite-plugin`. Run the install step `tubeless init cloudflare` prints; it pins `cf`, `vite` and the plugin.                                                                             |
| `Cannot resolve entry module index.html` from `cf build` or `cf deploy`                                      | `vite.config.ts` is missing or does not register `cloudflare()`. Restore it from the [example](../examples/cloudflare/vite.config.ts).                                                                                              |
