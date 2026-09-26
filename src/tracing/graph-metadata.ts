import { snapshotJsonMetadata, type ArtifactJsonValue } from "./artifact-metadata.js";
import { wireCustom } from "./wire-schema.js";

/** Bounded JSON values for descriptive pipeline and step annotations. */
export type PipelineMetadataValue = ArtifactJsonValue;

/** Descriptive only. Values never select work or inherit across pipeline boundaries. */
export interface PipelineMetadata {
  readonly tags?: readonly string[];
  readonly owner?: string;
  readonly domain?: string;
  readonly annotations?: Readonly<Record<string, PipelineMetadataValue>>;
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export const pipelineMetadataSchema = wireCustom<PipelineMetadata>(
  {
    type: "object",
    additionalProperties: false,
    properties: {
      tags: {
        type: "array",
        maxItems: 64,
        items: { type: "string", minLength: 1, maxLength: 256 },
      },
      owner: { type: "string", minLength: 1, maxLength: 256 },
      domain: { type: "string", minLength: 1, maxLength: 256 },
      annotations: { type: "object", additionalProperties: true },
    },
  },
  (value, path) => {
    const snapshot = snapshotJsonMetadata(value, path);
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
      throw new TypeError(`${path} must be an object`);
    }
    const text = (entry: unknown): entry is string =>
      typeof entry === "string" && entry.trim().length > 0 && entry.length <= 256;
    for (const [key, entry] of Object.entries(snapshot)) {
      if (key === "tags") {
        if (!Array.isArray(entry) || entry.length > 64 || !entry.every(text)) {
          throw new TypeError(
            `${path}.tags must contain at most 64 nonblank strings of at most 256 characters`
          );
        }
      } else if (key === "owner" || key === "domain") {
        if (!text(entry))
          throw new TypeError(`${path}.${key} must be a nonblank string of at most 256 characters`);
      } else if (key === "annotations") {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
          throw new TypeError(`${path}.annotations must be an object`);
        }
      } else {
        throw new TypeError(`${path}.${key} is unknown; use annotations for application fields`);
      }
    }
    // SAFETY: each allowed field is validated above, and nested values are bounded JSON.
    return freeze(snapshot as PipelineMetadata);
  }
);

export function snapshotPipelineMetadata(
  value: PipelineMetadata | undefined
): PipelineMetadata | undefined {
  return value === undefined ? undefined : pipelineMetadataSchema.decode(value, "metadata");
}
