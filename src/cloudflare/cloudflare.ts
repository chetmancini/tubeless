import type { RunJob, StudioIngest } from "../hosting/run-contract.js";
import { DurableObject } from "cloudflare:workers";
import type { AnyProjectPipeline, PipelineProject } from "../project/pipeline-project.js";
import { hostedProjectCommands } from "../hosting/hosting-commands.js";
import { errorResponse } from "../studio/server/http.js";
import type { PipelineTraceEvent, PipelineTraceExporterOptions } from "../tracing/tracing.js";
import { createAccessAuthenticator, parseAccessConfig } from "./cloudflare-access.js";
import { MAX_RUN_DURATION_MS, type CloudflareRunTraceContext } from "./cloudflare-run-contract.js";
import { RunObjectCore } from "./cloudflare-run.js";
import { StudioObjectCore, type RunStubLike } from "./cloudflare-studio.js";
import {
  isLaunchIdentifier,
  type HostedLaunchRequest,
  type HostedLaunchResult as CloudflareLaunchResult,
  type HostedLaunchStatus as CloudflareLaunchStatus,
  type HostedLaunchValues as CloudflareLaunchValues,
} from "../hosting/launch-admission.js";
export type {
  HostedLaunchResult as CloudflareLaunchResult,
  HostedLaunchStatus as CloudflareLaunchStatus,
  HostedLaunchValues as CloudflareLaunchValues,
} from "../hosting/launch-admission.js";
import type { DurableStorageLike } from "./cloudflare-storage.js";
import { PIPELINE_RUN_STUDIO_CLIENT } from "./cloudflare-studio-client.js";
import type { AgentTranscriptRecord } from "../tracing/agent-transcript.js";
import type { CloudflareTranscriptIngest } from "./cloudflare-transcript.js";
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
}

/** Configure deployment identity, application tracing and the cooperative run deadline. */
export interface CloudflareAppOptions<TEnv = unknown> {
  /** Immutable code/configuration revision. Required for programmatic launches; change it on redeploy. */
  readonly deploymentId?: string;
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
  readonly durableObjects: {
    readonly TubelessStudio: CloudflareDurableObjectClass<CloudflareTranscriptIngest>;
    readonly TubelessRun: CloudflareDurableObjectClass;
  };
}

interface NamespaceLike<T> {
  getByName(name: string): T;
}

interface StudioStub extends StudioIngest {
  fetch(request: Request): Promise<Response>;
  launch(request: HostedLaunchRequest): Promise<CloudflareLaunchResult>;
  getLaunch(launchId: string): Promise<CloudflareLaunchStatus | undefined>;
}

interface TubelessEnv {
  readonly TUBELESS_STUDIO: NamespaceLike<StudioStub>;
  readonly TUBELESS_RUN: NamespaceLike<RunStubLike>;
  readonly ACCESS_TEAM_DOMAIN?: string;
  readonly ACCESS_AUD?: string;
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
  const commands = new Map(
    hostedProjectCommands(project).map((entry) => [entry.descriptor.id, entry])
  );
  let authenticator:
    | { key: string; authenticate: (request: Request) => Promise<Response | undefined> }
    | undefined;

  const worker: CloudflareWorker = {
    async fetch(request, rawEnv) {
      // SAFETY: the scaffolded configuration binds these names; missing bindings fail at the call below.
      const env = rawEnv as TubelessEnv;
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
        const denial = await authenticator.authenticate(request);
        if (denial) return denial;
      } else if (!LOOPBACK_HOSTS.has(new URL(request.url).hostname)) {
        return errorResponse(
          503,
          "access_not_configured",
          "Cloudflare Access is not configured.",
          "Enable Cloudflare Access for this Worker, set ACCESS_TEAM_DOMAIN and ACCESS_AUD, then redeploy."
        );
      }
      try {
        // Forward the original request: the Studio host checks mutation Origin against its URL.
        return await env.TUBELESS_STUDIO.getByName("default").fetch(request);
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
        runStub: (launchId) => env.TUBELESS_RUN.getByName(launchId),
      });
    }

    fetch(request: Request): Promise<Response> {
      return this.#core.fetch(request);
    }

    launch(request: HostedLaunchRequest) {
      return this.#core.launch(request);
    }

    getLaunch(launchId: string) {
      return this.#core.getLaunch(launchId);
    }

    admit(launchId: string): Promise<{ admitted: boolean }> {
      return this.#core.admit(launchId);
    }

    appendEvents(
      launchId: string,
      sequence: number,
      events: PipelineTraceEvent[]
    ): Promise<{ accepted: boolean }> {
      return this.#core.appendEvents(launchId, sequence, events);
    }

    reportFailure(launchId: string, message: string): Promise<void> {
      return this.#core.reportFailure(launchId, message);
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
        ingest: () => env.TUBELESS_STUDIO.getByName("default"),
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
      // SAFETY: the scaffold binds this private namespace; no HTTP route exposes this capability.
      const env = rawEnv as TubelessEnv;
      return env.TUBELESS_STUDIO.getByName("default").launch({
        commandId,
        values,
        idempotencyKey: launchOptions?.idempotencyKey,
        projectId: project.id,
        deploymentId,
      });
    },
    async getLaunch(rawEnv, launchId) {
      if (!isLaunchIdentifier(launchId)) return undefined;
      const env = rawEnv as TubelessEnv;
      return env.TUBELESS_STUDIO.getByName("default").getLaunch(launchId);
    },
  };
}
