import type { ArtifactMetadata } from "../tracing/artifact-metadata.js";

/** Read the reserved cache receipt namespace without treating arbitrary metadata as cache data. */
export function cacheArtifactMetadata(artifact: ArtifactMetadata) {
  const cache = artifact.metadata?.tubelessCache;
  if (
    !cache ||
    typeof cache !== "object" ||
    Array.isArray(cache) ||
    !("implementationVersion" in cache) ||
    typeof cache.implementationVersion !== "string" ||
    !("createdAtMs" in cache) ||
    typeof cache.createdAtMs !== "number" ||
    !Number.isFinite(cache.createdAtMs) ||
    !("ageMs" in cache) ||
    typeof cache.ageMs !== "number" ||
    !Number.isFinite(cache.ageMs)
  )
    return undefined;
  return {
    implementationVersion: cache.implementationVersion,
    createdAtMs: cache.createdAtMs,
    ageMs: cache.ageMs,
  };
}
