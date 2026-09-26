import {
  wireCustom,
  wireEnum,
  wireNumber,
  wireObject,
  wireOptional,
  wireString,
  type InferWireSchema,
} from "./wire-schema.js";

/** JSON values accepted in persisted artifact metadata. */
export type ArtifactJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly ArtifactJsonValue[]
  | { readonly [key: string]: ArtifactJsonValue };

/** Identifies an artifact without recording its contents. Supply at least id or uri. */
export type ArtifactMetadata = {
  readonly mediaType?: string;
  readonly checksum?: string;
  readonly version?: string;
  readonly byteSize?: number;
  readonly schemaVersion?: string;
  readonly metadata?: Readonly<Record<string, ArtifactJsonValue>>;
} & (
  | { readonly id: string; readonly uri?: string }
  | { readonly id?: string; readonly uri: string }
);

const BYTE_LIMIT = 16_384;
const encoder = new TextEncoder();

// Validate before JSON serialization: never invoke toJSON/getters or silently lose values.
export function snapshotJsonMetadata(value: unknown, path: string): ArtifactJsonValue {
  let nodes = 0;
  let bytes = 0;
  const charge = (text: string) => {
    if (text.length > BYTE_LIMIT) throw new Error(`${path} exceeds ${BYTE_LIMIT} bytes`);
    bytes += encoder.encode(JSON.stringify(text)).byteLength;
    if (bytes > BYTE_LIMIT) throw new Error(`${path} exceeds ${BYTE_LIMIT} bytes`);
  };
  const visit = (item: unknown, depth: number): ArtifactJsonValue => {
    if (++nodes > 256 || depth > 8) throw new Error(`${path} exceeds metadata complexity limits`);
    if (item === null || typeof item === "boolean") return item;
    if (typeof item === "number" && Number.isFinite(item)) return item;
    if (typeof item === "string") {
      charge(item);
      return item;
    }
    if (typeof item !== "object" || item === null) throw new Error(`${path} must be JSON-safe`);
    const array = Array.isArray(item);
    const prototype = Object.getPrototypeOf(item);
    if (!array && prototype !== Object.prototype && prototype !== null) {
      throw new Error(`${path} must contain only plain JSON objects`);
    }
    const keys = Reflect.ownKeys(item);
    if (keys.length > 256) throw new Error(`${path} exceeds metadata complexity limits`);
    const entries: [string, ArtifactJsonValue][] = [];
    for (const key of keys) {
      if (array && key === "length") continue;
      if (typeof key !== "string") throw new Error(`${path} must be JSON-safe`);
      const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
      if (!("value" in descriptor) || !descriptor.enumerable) {
        throw new Error(`${path} must contain only enumerable data properties`);
      }
      charge(key);
      entries.push([key, visit(descriptor.value, depth + 1)]);
    }
    if (array) {
      if (entries.length !== item.length || entries.some(([key], index) => key !== String(index))) {
        throw new Error(`${path} must contain only dense JSON arrays`);
      }
      return entries.map(([, entry]) => entry);
    }
    return Object.fromEntries(entries);
  };
  const snapshot = visit(value, 0);
  if (encoder.encode(JSON.stringify(snapshot)).byteLength > BYTE_LIMIT) {
    throw new Error(`${path} exceeds ${BYTE_LIMIT} bytes`);
  }
  return snapshot;
}

const text = wireString({ maxLength: 4096 });
const shape = wireObject({
  id: wireOptional(text),
  uri: wireOptional(text),
  mediaType: wireOptional(text),
  checksum: wireOptional(text),
  version: wireOptional(text),
  byteSize: wireOptional(wireNumber({ integer: true, minimum: 0 })),
  schemaVersion: wireOptional(text),
  metadata: wireOptional(
    wireCustom<Readonly<Record<string, ArtifactJsonValue>>>(
      { type: "object", additionalProperties: true },
      (value, path) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          throw new Error(`${path} must be an object`);
        }
        // SAFETY: the outer metadata decoder has already made a bounded JSON snapshot.
        return value as Readonly<Record<string, ArtifactJsonValue>>;
      }
    )
  ),
});

export const artifactMetadataSchema = wireCustom<ArtifactMetadata>(
  { ...shape.jsonSchema, anyOf: [{ required: ["id"] }, { required: ["uri"] }] },
  (value, path) => {
    const snapshot = snapshotJsonMetadata(value, path);
    const decoded = shape.decode(snapshot, path);
    if (!decoded.id && !decoded.uri) throw new Error(`${path} requires id or uri`);
    const allowed = [
      "id",
      "uri",
      "mediaType",
      "checksum",
      "version",
      "byteSize",
      "schemaVersion",
      "metadata",
    ];
    if (Object.keys(snapshot!).some((key) => !allowed.includes(key))) {
      throw new Error(`${path} has unknown fields; use metadata for application fields`);
    }
    return decoded.id ? { ...decoded, id: decoded.id } : { ...decoded, uri: decoded.uri! };
  }
);

export const artifactOperationSchema = wireEnum(["read", "write", "reuse"] as const);
export const artifactRecordSchema = wireObject({
  operation: artifactOperationSchema,
  artifact: artifactMetadataSchema,
});

/** A completed artifact operation recorded by a step; reuse does not claim a new write. */
export type ArtifactRecord = InferWireSchema<typeof artifactRecordSchema>;
