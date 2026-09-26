import { createHash } from "node:crypto";
import {
  artifactMetadataSchema,
  artifactRecordSchema,
  type ArtifactMetadata,
  type ArtifactRecord,
} from "../tracing/artifact-metadata.js";
import { isAbortError, throwIfAborted } from "../utilities/abort.js";
import { cacheDurationMs } from "../utilities/cache-duration.js";
import { defaultCacheKey } from "../utilities/cache-key.js";
import type { PipelineExecutionContext } from "./pipeline-types.js";

/** Cache I/O is cancellable and independent of pipeline scheduling. */
export interface StepCacheContext {
  readonly signal?: AbortSignal;
}

/** Encoded raw handler result and its creation time; expiration is enforced by core. */
export interface StepCacheEntry {
  readonly value: Uint8Array;
  readonly createdAtMs: number;
  /** Optional receipt identifying the stored bytes, refreshed by the adapter on reads. */
  readonly artifact?: ArtifactMetadata;
}

/** Store timestamped encoded handler results; only undefined means a cache miss. */
export interface StepCacheStore {
  get(
    key: string,
    context: StepCacheContext
  ): StepCacheEntry | undefined | Promise<StepCacheEntry | undefined>;
  /** Return an optional receipt after persistence succeeds; core supplies a stable artifact ID. */
  set(
    key: string,
    entry: StepCacheEntry,
    context: StepCacheContext
  ): void | ArtifactMetadata | Promise<void | ArtifactMetadata>;
}

/** Encode a detached snapshot; decode must produce a fresh handler-result value. */
export interface StepCacheCodec {
  encode(value: unknown): Uint8Array | Promise<Uint8Array>;
  decode(value: Uint8Array): unknown | Promise<unknown>;
}

/** Use reads and writes, recompute replaces entries, bypass performs no cache work. */
export type StepCachePolicy = "use" | "recompute" | "bypass";

interface CacheSettings {
  /** Maximum acceptable age: milliseconds or a fixed duration such as "30 days" or "12h". */
  readonly maxAge?: string | number;
  readonly store?: StepCacheStore;
  readonly codec?: StepCacheCodec;
}

/** Defaults for opted-in steps; configuring defaults does not make other steps cacheable. */
export interface PipelineCacheOptions extends CacheSettings {
  /** Root directory relative to the run's cwd; defaults to .cache with pipeline/step subdirectories. */
  readonly directory?: string;
}

type CachePolicyResolver<TInputs, TOptions extends object> = {
  resolve(
    inputs: TInputs,
    context: PipelineExecutionContext<TOptions>
  ): StepCachePolicy | Promise<StepCachePolicy>;
}["resolve"];

/** Opt a deterministic ordinary step into caching, with optional overrides of pipeline defaults. */
export interface StepCache<TInputs, TOptions extends object = {}> extends CacheSettings {
  /** Explicit implementation identity; defaults to the pipeline's implementationVersion. */
  readonly version?: string;
  /** Override the hash of dependency inputs and validated options; null bypasses this invocation. */
  key?(
    inputs: TInputs,
    context: PipelineExecutionContext<TOptions>
  ): string | null | Promise<string | null>;
  readonly policy?: StepCachePolicy | CachePolicyResolver<TInputs, TOptions>;
}

export interface CompiledStepCache<TOptions extends object> extends StepCache<
  Record<string, unknown>,
  TOptions
> {
  readonly version: string;
  readonly directory: string;
  readonly maxAge?: number;
}

function validateSettings(settings: CacheSettings): void {
  if (!settings || typeof settings !== "object" || Array.isArray(settings))
    throw new Error("Cache settings must be an object");
  cacheDurationMs(settings.maxAge);
  if (
    settings.store !== undefined &&
    (typeof settings.store?.get !== "function" || typeof settings.store?.set !== "function")
  )
    throw new Error("Cache store requires get and set methods");
  if (
    settings.codec !== undefined &&
    (typeof settings.codec?.encode !== "function" || typeof settings.codec?.decode !== "function")
  )
    throw new Error("Cache codec requires encode and decode methods");
}

export function validatePipelineCache(settings: PipelineCacheOptions | undefined): void {
  if (settings === undefined) return;
  validateSettings(settings);
  if (
    settings.directory !== undefined &&
    (typeof settings.directory !== "string" || !settings.directory.trim())
  )
    throw new Error("Cache directory must be nonblank");
}

export function compileStepCache<TOptions extends object>(
  source: boolean | StepCache<Record<string, unknown>, TOptions> | undefined,
  defaults: PipelineCacheOptions | undefined,
  implementationVersion: string | undefined
): CompiledStepCache<TOptions> | undefined {
  if (source === undefined || source === false) return undefined;
  const config = source === true ? {} : source;
  validateSettings(config);
  const version = config.version ?? implementationVersion;
  if (typeof version !== "string" || !version.trim() || version.length > 256)
    throw new Error(
      "Cached steps require a nonblank version or pipeline implementationVersion of at most 256 characters"
    );
  if (config.key !== undefined && typeof config.key !== "function")
    throw new Error("Cache key must be a function");
  if (
    config.policy !== undefined &&
    typeof config.policy !== "function" &&
    !["use", "recompute", "bypass"].includes(config.policy)
  )
    throw new Error("Invalid cache policy");
  const store = config.store ?? defaults?.store;
  const codec = config.codec ?? defaults?.codec;
  return Object.freeze({
    version,
    directory: defaults?.directory ?? ".cache",
    maxAge: cacheDurationMs(config.maxAge ?? defaults?.maxAge),
    key: config.key?.bind(config),
    policy: typeof config.policy === "function" ? config.policy.bind(config) : config.policy,
    store: store
      ? Object.freeze({ get: store.get.bind(store), set: store.set.bind(store) })
      : undefined,
    codec: codec
      ? Object.freeze({ encode: codec.encode.bind(codec), decode: codec.decode.bind(codec) })
      : undefined,
  });
}

async function cacheOperation<T>(
  operation: string,
  context: StepCacheContext,
  run: () => T | Promise<T>
): Promise<T> {
  throwIfAborted(context.signal, "Step cache");
  try {
    const result = await run();
    throwIfAborted(context.signal, "Step cache");
    return result;
  } catch (cause) {
    throwIfAborted(context.signal, "Step cache");
    if (isAbortError(cause)) throw cause;
    throw new Error(`Step cache ${operation} failed`, { cause });
  }
}

/** One execution path: cache raw handler results, then validate every publication. */
export async function executeWithStepCache<TOptions extends object>(input: {
  cache: CompiledStepCache<TOptions> | undefined;
  pipelineId: string;
  stepId: string;
  inputs: Record<string, unknown>;
  context: PipelineExecutionContext<TOptions>;
  run(): Promise<unknown>;
  validate(value: unknown): Promise<unknown>;
  onHit(): void;
  onArtifact(record: ArtifactRecord): void;
}): Promise<unknown> {
  const { cache, context } = input;
  const uncached = async () => input.validate(await input.run());
  if (!cache || context.dryRun) return uncached();
  const policy = await cacheOperation(
    "policy",
    context,
    () =>
      context.cachePolicy ??
      (typeof cache.policy === "function"
        ? cache.policy(input.inputs, context)
        : (cache.policy ?? "use"))
  );
  if (policy === "bypass") return uncached();
  if (policy !== "use" && policy !== "recompute") throw new Error("Invalid step cache policy");
  const key = await cacheOperation("key", context, () =>
    cache.key ? cache.key(input.inputs, context) : defaultCacheKey(input.inputs, context.options)
  );
  if (key === null) return uncached();
  if (typeof key !== "string" || !key.trim())
    throw new Error("Step cache key must be a nonblank string or null");
  const scopedKey = JSON.stringify([
    "tubeless.step-cache.v1",
    input.pipelineId,
    input.stepId,
    cache.version,
    key,
  ]);
  // Load the optional built-in persistence only when an eligible step needs it.
  const local =
    !cache.store || !cache.codec ? await import("../utilities/cache-storage.js") : undefined;
  const store =
    cache.store ??
    local!.defaultFileStepCache(context.cwd, cache.directory, input.pipelineId, input.stepId);
  const codec = cache.codec ?? local!.v8StepCacheCodec;
  const io = { signal: context.signal };
  const recordArtifact = (
    operation: "write" | "reuse",
    createdAtMs: number,
    receipt?: ArtifactMetadata | void
  ) => {
    const artifact =
      receipt === undefined
        ? undefined
        : artifactMetadataSchema.decode(receipt, "cache artifact receipt");
    input.onArtifact(
      artifactRecordSchema.decode(
        {
          operation,
          artifact: {
            ...artifact,
            id: `tubeless:step-cache:${createHash("sha256").update(scopedKey).digest("hex")}`,
            metadata: {
              ...artifact?.metadata,
              tubelessCache: {
                implementationVersion: cache.version,
                createdAtMs,
                ageMs: context.now() - createdAtMs,
                ...(cache.maxAge === undefined ? {} : { maxAgeMs: cache.maxAge }),
              },
            },
          },
        },
        "cache artifact record"
      )
    );
  };
  if (policy === "use") {
    const entry = await cacheOperation("read", io, async () => {
      const found = await store.get(scopedKey, io);
      if (found === undefined) return undefined;
      if (!found || !(found.value instanceof Uint8Array) || !Number.isFinite(found.createdAtMs))
        throw new Error("Invalid cache entry");
      const age = context.now() - found.createdAtMs;
      return cache.maxAge !== undefined && (age < 0 || age >= cache.maxAge) ? undefined : found;
    });
    if (entry !== undefined) {
      input.onHit();
      const raw = await cacheOperation("decode", io, () =>
        codec.decode(Uint8Array.from(entry.value))
      );
      const value = await input.validate(raw);
      throwIfAborted(context.signal, "Step cache");
      recordArtifact("reuse", entry.createdAtMs, entry.artifact);
      return value;
    }
  }
  const raw = await input.run();
  const bytes = await cacheOperation("encode", io, async () => {
    const encoded = await codec.encode(raw);
    if (!(encoded instanceof Uint8Array)) throw new Error("Cache codec must encode bytes");
    return Uint8Array.from(encoded);
  });
  const value = await input.validate(raw);
  await cacheOperation("write", io, async () => {
    const createdAtMs = context.now();
    const receipt = await store.set(scopedKey, { value: bytes, createdAtMs }, io);
    // A completed write remains observable even if cancellation follows persistence.
    recordArtifact("write", createdAtMs, receipt);
  });
  return value;
}
