import { digestCanonicalJson, isJsonObject } from "../canonical-json.js";

/** Exact file selectors for one configured Vitest step. */
export type NodeCheckFileRequest = { version: 1; stepId: string } & (
  | { mode: "inventory" | "full"; files?: never }
  | { mode: "selected"; files: readonly string[] }
);

/** Complete configured specifications for one Vitest step. Paths are sorted, unique and relative to the repository. */
export interface NodeCheckFileInventory {
  version: 1;
  complete: true;
  files: string[];
  stepId: string;
  planDigest: string;
  source: { commit: string | null; treeSha: string | null; lockfileDigest: string };
  toolchain: { node: string; bun: string; vitest: string; platform: string; arch: string };
  /** The primary config file. Its digest does not cover imports, plugins or environment inputs. */
  configuration: { path: string; digest: string } | null;
}

/** One Vitest module completion. Duration measures tests and hooks, in milliseconds. */
export interface NodeCheckFileCompletion {
  path: string;
  state: "passed" | "failed" | "skipped";
  durationMs: number | null;
}

/** Maximum number of file identities, UTF-8 bytes per path, and UTF-8 bytes per JSON list. */
export const NODE_CHECK_FILE_LIMITS = Object.freeze({
  files: 4096,
  pathBytes: 1024,
  listBytes: 512 * 1024,
} as const);
const utf8 = new TextEncoder();

export function isNodeCheckFilePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    !/[\\:\p{Cc}\p{Cs}]/u.test(value) &&
    value.length <= NODE_CHECK_FILE_LIMITS.pathBytes &&
    utf8.encode(value).length <= NODE_CHECK_FILE_LIMITS.pathBytes &&
    value.split("/").every((part) => part !== "" && part !== "." && part !== "..")
  );
}

export function normalizeNodeCheckFiles(value: unknown): string[] {
  if (!Array.isArray(value)) throw new TypeError("Expected an array of Vitest file paths.");
  if (value.length > NODE_CHECK_FILE_LIMITS.files)
    throw new TypeError("Vitest file list exceeds 4096 files.");
  const paths = new Set<string>();
  let bytes = 1;
  const files = Array.from(value, (path: unknown) => {
    if (!isNodeCheckFilePath(path))
      throw new TypeError("Invalid repository-relative Vitest file path.");
    const key = path.normalize("NFC").toLowerCase();
    if (paths.has(key)) throw new TypeError(`Duplicate or colliding Vitest file path: ${path}.`);
    paths.add(key);
    bytes += utf8.encode(JSON.stringify(path)).length + 1;
    if (bytes > NODE_CHECK_FILE_LIMITS.listBytes)
      throw new TypeError("Vitest file list exceeds 512 KiB.");
    return path;
  });
  return files.sort();
}

/** Validate and canonicalize a v1 request without reading or executing source. Throws on unsupported data. */
export function decodeNodeCheckFileRequest(value: unknown): NodeCheckFileRequest {
  if (
    !isJsonObject(value) ||
    value.version !== 1 ||
    typeof value.stepId !== "string" ||
    !/^[a-z][a-z0-9-]{0,47}$/.test(value.stepId) ||
    Object.keys(value).some((key) => !["version", "stepId", "mode", "files"].includes(key))
  )
    throw new TypeError("Invalid or unsupported Node check file request.");
  const { stepId, mode } = value;
  if (mode === "selected") {
    const files = normalizeNodeCheckFiles(value.files);
    if (!files.length) throw new TypeError("Select at least one Vitest file.");
    return { version: 1, stepId, mode, files };
  }
  if ((mode === "inventory" || mode === "full") && !Object.hasOwn(value, "files"))
    return { version: 1, stepId, mode };
  throw new TypeError("Invalid Node check file request mode or file list.");
}

/** Bind the canonical request to a v1 plan digest using the same JSON and SHA-256 encoding as the plan. */
export async function digestNodeCheckFileRequest(
  planDigest: string,
  request: NodeCheckFileRequest
): Promise<string> {
  return digestCanonicalJson({ planDigest, request: decodeNodeCheckFileRequest(request) });
}

/** Identify a complete inventory and its recorded context. */
export async function digestNodeCheckFileInventory(
  inventory: NodeCheckFileInventory
): Promise<string> {
  return digestCanonicalJson(inventory);
}
