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
bun add tubeless && bun add -d --exact cf@1.0.0-rc.0 vite@8.3.8 @cloudflare/vite-plugin@2.0.0-beta.v.17   # npm install -D -E … / pnpm add -D -E …
grep -qxF '.cloudflare/' .gitignore 2>/dev/null || printf '\n.cloudflare/\n' >> .gitignore   # cf build output and generated types
npx cf auth login
npx cf dev            # Studio on http://localhost:8787 (Access is skipped only on localhost)
npx cf deploy         # creates the Worker, Durable Objects and R2 bucket
```

- Deploying needs Node 22.12 or later. `cf` is the Cloudflare configuration CLI and
  is in beta.
- Install the pinned versions with `--exact` (`-E` for npm and pnpm): they were
  verified together, and a `^` range can resolve to an untested beta.
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

An unconfirmed dispatch is never run again: reconciliation marks it failed, and a
queued job from an older deployment is refused before user code runs. Use a new key
only to deliberately request another run. This is submission deduplication, not crash
resume or side-effect idempotency.

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

**A run executes inside one Durable Object alarm, so it has at most 15 minutes of
wall time.** Tubeless aborts at 14 minutes so it can record its own failure. Set a
shorter limit with `createCloudflareApp(project, { limits: { maxRunDurationMs } })`
(at most 840,000 ms). Waiting for a launch to start does not consume it.

- **CPU:** 30 seconds by default; Workers Paid allows up to 5 minutes via
  `limits: { cpuMs: 300_000 }` in `cloudflare.config.ts` (commented out in the
  scaffold). I/O waits do not count. Use Workers Paid for real pipelines.
- **Recorded text:** log, progress, skip and error text beyond 65,536 characters is
  truncated in history (Durable Object row limit); local history keeps it all.
- **No crash resume:** a run that is cut off is recorded as failed.

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
