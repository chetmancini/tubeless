import { isAuthoredPipelineId } from "../core/pipeline-ids.js";
import type { HostedFailureReason, RunJob } from "../hosting/run-contract.js";
import { DurableObject } from "cloudflare:workers";
import type { AnyProjectPipeline, PipelineProject } from "../project/pipeline-project.js";
import { hostedProjectCommands } from "../hosting/hosting-commands.js";
import { errorResponse } from "../studio/server/http.js";
import type { PipelineTraceEvent, PipelineTraceExporterOptions } from "../tracing/tracing.js";
import { createAccessAuthenticator, parseAccessConfig } from "./cloudflare-access.js";
import { MAX_RUN_DURATION_MS, type CloudflareRunTraceContext } from "./cloudflare-run-contract.js";
import { RunObjectCore } from "./cloudflare-run.js";
import { StudioObjectCore, type RunStubLike } from "./cloudflare-studio.js";
import type { CloudflareStudioIngest } from "./cloudflare-studio-ingest.js";
import type {
  HostedLaunchRequest,
  HostedLaunchResult as CloudflareLaunchResult,
  HostedLaunchStatus as CloudflareLaunchStatus,
  HostedLaunchValues as CloudflareLaunchValues,
} from "../hosting/launch-admission.js";
import type { HostedExecutionStatus as CloudflareExecutionStatus } from "../hosting/execution-status.js";
import { isLaunchIdentifier } from "../utilities/launch-identifier.js";
import { isExecutionPath, serveExecutionRequest } from "./cloudflare-execution-api.js";
import { isRunnerPath } from "./cloudflare-runner-api.js";
import { placeCloudflareChild, type RunnerStageStore } from "./cloudflare-child-placement.js";
import { MAX_RUNNER_MANIFEST_PIPELINES, type RunnerJob } from "../hosting/runner-protocol.js";
import type { DurableStorageLike } from "./cloudflare-storage.js";
import type {
  LaunchActor,
  LaunchTrigger,
  LaunchInputPolicy,
} from "../studio/shared/launch-metadata.js";
import { launchInputPolicy } from "../hosting/launch-metadata.js";
import { PIPELINE_RUN_STUDIO_CLIENT } from "./cloudflare-studio-client.js";
import type { AgentTranscriptRecord } from "../tracing/agent-transcript.js";
import type { CloudflareTranscriptIngest } from "./cloudflare-transcript.js";
export type {
  HostedLaunchResult as CloudflareLaunchResult,
  HostedLaunchStatus as CloudflareLaunchStatus,
  HostedLaunchValues as CloudflareLaunchValues,
} from "../hosting/launch-admission.js";
export type { HostedExecutionStatus as CloudflareExecutionStatus } from "../hosting/execution-status.js";
export type {
  LaunchActor as CloudflareLaunchActor,
  LaunchTrigger as CloudflareLaunchTrigger,
} from "../studio/shared/launch-metadata.js";
export {
  createCloudflareAgentTranscriptWriter,
  type CloudflareTranscriptIngest,
} from "./cloudflare-transcript.js";

export {
  createWorkerLoaderCodemodeExecutor,
  type WorkerLoaderCodemodeOptions,
  type WorkerLoaderLike,
} from "./cloudflare-codemode.js";

export {
  createR2CacheStore,
  jsonCacheCodec,
  type R2BucketLike,
  type R2ObjectLike,
} from "./cloudflare-cache.js";

/** Context for one admitted Cloudflare launch, including this Durable Object's bindings. */
export interface CloudflareTraceContext<TEnv = unknown> extends CloudflareRunTraceContext {
  readonly env: TEnv;
}

/** Reuse the same key for every delivery of one logical submission. */
export interface CloudflareLaunchOptions {
  readonly idempotencyKey: string;
  /** Attribution supplied by trusted application code, never read from browser input. */
  readonly actor?: LaunchActor;
  /** Defaults to code. */
  readonly trigger?: LaunchTrigger;
}

/** Configure deployment identity, application tracing and the cooperative run deadline. */
export interface CloudflareAppOptions<TEnv = unknown> {
  /** Immutable code/configuration revision. Required for programmatic launches; change it on redeploy. */
  readonly deploymentId?: string;
  /** Input values saved in Studio history, by command id and parameter key. Defaults to none. */
  readonly recordInputs?: LaunchInputPolicy;
  /** Recover interrupted versioned Worker and Bun roots under their original execution ID. */
  readonly recoverInterruptedRuns?: boolean;
  /** Registered pipelines that run on the enrolled local Bun runner. Others run on the Worker. */
  readonly localRunner?: {
    /** Client ID of the Access service token enrolled for local work. */
    readonly serviceId: string;
    readonly pipelines: readonly string[];
  };
  /** Extra destinations composed with project exporters and Studio ingestion. */
  readonly tracing?: PipelineTraceExporterOptions<CloudflareTraceContext<TEnv>>;
  readonly limits?: {
    /** Cooperative run deadline. Defaults to and may not exceed 14 minutes (alarm wall time is 15). */
    readonly maxRunDurationMs?: number;
  };
}

/** Worker module handler to use as the Worker entry's default export. */
export interface CloudflareWorker {
  fetch(request: Request, env: unknown, ctx?: unknown): Promise<Response>;
}

/** Durable Object class to export from the Worker entry under its binding's export name. */
export type CloudflareDurableObjectClass<Instance extends object = object> = abstract new (
  ctx: never,
  env: never
) => Instance;

/** Worker handler and Durable Object classes that a Worker entry exports. */
export interface CloudflareApp {
  readonly worker: CloudflareWorker;
  /** Trusted code capability; a successful receipt confirms admission, not execution success. */
  launch(
    env: unknown,
    commandId: string,
    values: CloudflareLaunchValues,
    options: CloudflareLaunchOptions
  ): Promise<CloudflareLaunchResult>;
  /** Read current launch state and its run id; undefined when the launch does not exist. */
  getLaunch(env: unknown, launchId: string): Promise<CloudflareLaunchStatus | undefined>;
  /** Inspect the execution using the launch ID returned by admission. */
  getExecution(env: unknown, executionId: string): Promise<CloudflareExecutionStatus | undefined>;
  /** Persist a cancellation request and return the current status, including whether it stopped. */
  cancelExecution(
    env: unknown,
    executionId: string
  ): Promise<CloudflareExecutionStatus | undefined>;
  readonly durableObjects: {
    readonly TubelessStudio: CloudflareDurableObjectClass<CloudflareTranscriptIngest>;
    readonly TubelessRun: CloudflareDurableObjectClass;
  };
}

interface NamespaceLike<T> {
  getByName(name: string): T;
}

interface StudioStub extends CloudflareStudioIngest, RunnerStageStore {
  serveRunner(request: Request): Promise<Response>;
  serve(request: Request, actor?: LaunchActor): Promise<Response>;
  launch(request: HostedLaunchRequest): Promise<CloudflareLaunchResult>;
  getLaunch(launchId: string): Promise<CloudflareLaunchStatus | undefined>;
  getExecution(launchId: string): Promise<CloudflareExecutionStatus | undefined>;
  cancelExecution(launchId: string): Promise<CloudflareExecutionStatus | undefined>;
}

interface TubelessEnv {
  readonly TUBELESS_STUDIO: NamespaceLike<StudioStub>;
  readonly TUBELESS_RUN: NamespaceLike<RunStubLike>;
  readonly ACCESS_TEAM_DOMAIN?: string;
  readonly ACCESS_AUD?: string;
}

function studioBinding(env: unknown): StudioStub {
  // SAFETY: the deployment scaffold binds the private namespace under this name.
  return (env as TubelessEnv).TUBELESS_STUDIO.getByName("default");
}

interface DurableObjectStateLike {
  readonly storage: DurableStorageLike;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function maxRunDuration(value: number | undefined): number {
  if (value === undefined) return MAX_RUN_DURATION_MS;
  if (!Number.isInteger(value) || value <= 0 || value > MAX_RUN_DURATION_MS) {
    throw new Error(
      `limits.maxRunDurationMs must be a positive integer no greater than ${MAX_RUN_DURATION_MS}.`
    );
  }
  return value;
}

function studioUnavailable(request: Request): Response {
  if (new URL(request.url).pathname.startsWith("/api/")) {
    return errorResponse(
      503,
      "studio_unavailable",
      "Studio is temporarily unavailable.",
      "Retry in a moment."
    );
  }
  return new Response("Studio is temporarily unavailable. Retry in a moment.\n", {
    status: 503,
    headers: { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" },
  });
}

/** Compose a single-tenant Tubeless deployment for a Worker with two SQLite Durable Objects. */
export function createCloudflareApp<TEnv = unknown>(
  project: PipelineProject<string, readonly AnyProjectPipeline[]>,
  options: CloudflareAppOptions<TEnv> = {}
): CloudflareApp {
  const maxRunDurationMs = maxRunDuration(options.limits?.maxRunDurationMs);
  const deploymentId = options.deploymentId;
  if (deploymentId !== undefined && !isLaunchIdentifier(deploymentId))
    throw new Error(
      "deploymentId must contain 1–200 letters, digits, periods, underscores, colons or hyphens."
    );
  if (options.recoverInterruptedRuns && !deploymentId)
    throw new Error("Run recovery requires deploymentId.");
  const commands = new Map(
    hostedProjectCommands(project).map((entry) => [entry.descriptor.id, entry])
  );
  const runnerService = options.localRunner?.serviceId;
  let localPipelines: ReadonlyMap<string, string> | undefined;
  if (options.localRunner !== undefined) {
    if (!deploymentId || !runnerService || runnerService.length > 1024)
      throw new Error("Local runner placement requires deploymentId and an Access serviceId.");
    if (
      options.localRunner.pipelines.length < 1 ||
      options.localRunner.pipelines.length > MAX_RUNNER_MANIFEST_PIPELINES
    )
      throw new Error(`Configure 1–${MAX_RUNNER_MANIFEST_PIPELINES} local runner pipelines.`);
    localPipelines = new Map(
      options.localRunner.pipelines.map((id) => {
        const identity = commands.get(id)?.command.plan().definition?.identity;
        if (!isAuthoredPipelineId(id) || !identity?.implementationVersion)
          throw new Error(
            `Local runner pipeline ${JSON.stringify(id)} requires a registered, versioned definition.`
          );
        return [id, identity.definitionId];
      })
    );
  }
  const inputPolicy = launchInputPolicy(commands, options.recordInputs);
  const submit = (
    studio: StudioStub,
    commandId: string,
    values: CloudflareLaunchValues,
    launchOptions: CloudflareLaunchOptions
  ) =>
    studio.launch({
      commandId,
      values,
      idempotencyKey: launchOptions?.idempotencyKey,
      projectId: project.id,
      deploymentId,
      context: { actor: launchOptions?.actor, trigger: launchOptions?.trigger },
    });
  let authenticator:
    | { key: string; authenticate: ReturnType<typeof createAccessAuthenticator> }
    | undefined;

  const worker: CloudflareWorker = {
    async fetch(request, rawEnv) {
      // SAFETY: the scaffolded configuration binds these names; missing bindings fail at the call below.
      const env = rawEnv as TubelessEnv;
      const url = new URL(request.url);
      let actor: LaunchActor | undefined;
      let config: ReturnType<typeof parseAccessConfig>;
      try {
        config = parseAccessConfig(env.ACCESS_TEAM_DOMAIN, env.ACCESS_AUD);
      } catch (error) {
        return errorResponse(
          503,
          "access_misconfigured",
          error instanceof Error ? error.message : "Access is misconfigured.",
          "Set both ACCESS_TEAM_DOMAIN and ACCESS_AUD, then redeploy."
        );
      }
      if (config) {
        const key = `${config.issuer}\0${config.audience}`;
        if (authenticator?.key !== key) {
          authenticator = { key, authenticate: createAccessAuthenticator(config) };
        }
        const identity = await authenticator.authenticate(request);
        if (identity instanceof Response) return identity;
        actor = identity;
      } else if (!LOOPBACK_HOSTS.has(url.hostname)) {
        return errorResponse(
          503,
          "access_not_configured",
          "Cloudflare Access is not configured.",
          "Enable Cloudflare Access for this Worker, set ACCESS_TEAM_DOMAIN and ACCESS_AUD, then redeploy."
        );
      }
      try {
        const studio = studioBinding(env);
        if (isRunnerPath(url.pathname)) {
          if (!runnerService || actor?.kind !== "service" || actor.id !== runnerService)
            return errorResponse(
              403,
              "runner_access_denied",
              "An enrolled Access service identity is required.",
              "Use the enrolled runner service token."
            );
          return await studio.serveRunner(request);
        }
        if (actor?.kind === "service" && actor.id === runnerService)
          return errorResponse(
            403,
            "runner_access_denied",
            "The runner credential is scoped to runner operations.",
            "Use a separate Access identity for executions or Studio."
          );
        if (isExecutionPath(url.pathname)) {
          if (config && !actor)
            return errorResponse(
              403,
              "access_denied",
              "An Access identity is required.",
              "Use an authorized Access identity or service token."
            );
          if (deploymentId === undefined)
            return errorResponse(
              503,
              "execution_api_not_configured",
              "The execution API requires a deploymentId.",
              "Set deploymentId on createCloudflareApp and redeploy."
            );
          return await serveExecutionRequest(request, url, {
            deployment: { projectId: project.id, deploymentId },
            launch: (commandId, values, idempotencyKey) =>
              submit(studio, commandId, values, { idempotencyKey, actor, trigger: "code" }),
            get: (id) => studio.getExecution(id),
            cancel: (id) => studio.cancelExecution(id),
          });
        }
        // Forward the original request: the Studio host checks mutation Origin against its URL.
        return await studio.serve(request, actor);
      } catch (error) {
        console.error(error);
        return studioUnavailable(request);
      }
    },
  };

  class TubelessStudio extends DurableObject<TubelessEnv> {
    readonly #core: StudioObjectCore;

    constructor(ctx: unknown, env: TubelessEnv) {
      super(ctx, env);
      // SAFETY: the Workers runtime passes DurableObjectState, whose storage satisfies DurableStorageLike.
      const state = ctx as DurableObjectStateLike;
      this.#core = new StudioObjectCore({
        storage: state.storage,
        commands,
        clientScript: PIPELINE_RUN_STUDIO_CLIENT,
        maxRunDurationMs,
        projectId: project.id,
        deploymentId,
        inputPolicy,
        localPipelines,
        recoverInterruptedRuns: options.recoverInterruptedRuns,
        runStub: (launchId) => env.TUBELESS_RUN.getByName(launchId),
      });
    }

    /** Private Worker-to-Studio RPC; identity is never accepted from HTTP headers or JSON. */
    serve(request: Request, actor?: LaunchActor): Promise<Response> {
      return this.#core.fetch(request, actor);
    }

    launch(request: HostedLaunchRequest) {
      return this.#core.launch(request);
    }

    getLaunch(launchId: string) {
      return this.#core.getLaunch(launchId);
    }

    getExecution(launchId: string) {
      return this.#core.getExecution(launchId);
    }

    cancelExecution(launchId: string) {
      return this.#core.cancelExecution(launchId);
    }

    serveRunner(request: Request) {
      return this.#core.serveRunner(request);
    }

    enqueueStage(job: RunnerJob & { kind: "stage" }, generation?: number) {
      return this.#core.enqueueStage(job, generation);
    }

    readStage(launchId: string, id: string, afterId: number) {
      return this.#core.readStage(launchId, id, afterId);
    }

    cancelStage(launchId: string, id: string, generation?: number) {
      return this.#core.cancelStage(launchId, id, generation);
    }

    admit(launchId: string, generation?: number): Promise<{ admitted: boolean }> {
      return this.#core.admit(launchId, generation);
    }

    appendEvents(
      launchId: string,
      sequence: number,
      events: PipelineTraceEvent[],
      generation?: number
    ): Promise<{ accepted: boolean }> {
      return this.#core.appendEvents(launchId, sequence, events, generation);
    }

    reportFailure(
      launchId: string,
      message: string,
      reason?: HostedFailureReason,
      generation?: number
    ): Promise<void> {
      return this.#core.reportFailure(launchId, message, reason, generation);
    }

    appendTranscript(record: AgentTranscriptRecord): Promise<{ accepted: boolean }> {
      return this.#core.appendTranscript(record);
    }

    alarm(): Promise<void> {
      return this.#core.alarm();
    }
  }

  class TubelessRun extends DurableObject<TubelessEnv> {
    readonly #core: RunObjectCore;

    constructor(ctx: unknown, env: TubelessEnv) {
      super(ctx, env);
      const state = ctx as DurableObjectStateLike;
      this.#core = new RunObjectCore({
        storage: state.storage,
        commands,
        deploymentId,
        ingest: () => studioBinding(env),
        placeChild:
          localPipelines && deploymentId
            ? (job, deadlineAtMs, flush, generation) =>
                placeCloudflareChild({
                  definitions: localPipelines,
                  launchId: job.launchId,
                  deploymentId,
                  deadlineAtMs,
                  flush,
                  generation,
                  store: () => studioBinding(env),
                })
            : undefined,
        tracing:
          options.tracing === undefined
            ? undefined
            : {
                exporters: (context) =>
                  options.tracing!.exporters({
                    ...context,
                    // SAFETY: the application supplies its Worker bindings type at registration.
                    env: env as TEnv,
                  }),
                onExporterError: options.tracing.onExporterError,
              },
      });
    }

    start(job: RunJob): Promise<void> {
      return this.#core.start(job);
    }

    cancel(): boolean {
      return this.#core.cancel();
    }

    alarm(): Promise<void> {
      return this.#core.alarm();
    }
  }

  return {
    worker,
    durableObjects: { TubelessStudio, TubelessRun },
    async launch(rawEnv, commandId, values, launchOptions) {
      if (deploymentId === undefined)
        return {
          accepted: false,
          code: "invalid_launch",
          errors: ["Configure deploymentId on createCloudflareApp before launching from code."],
        };
      return submit(studioBinding(rawEnv), commandId, values, launchOptions);
    },
    async getLaunch(rawEnv, launchId) {
      if (!isLaunchIdentifier(launchId)) return undefined;
      return studioBinding(rawEnv).getLaunch(launchId);
    },
    async getExecution(rawEnv, id) {
      if (!isLaunchIdentifier(id)) return undefined;
      return studioBinding(rawEnv).getExecution(id);
    },
    async cancelExecution(rawEnv, id) {
      if (!isLaunchIdentifier(id)) return undefined;
      return studioBinding(rawEnv).cancelExecution(id);
    },
  };
}
