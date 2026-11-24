import { canonicalJsonValue, isJsonObject } from "./canonical-json.js";
import { decodeNodeCheckPlan, type NodeCheckPlan } from "./node-check-plan.js";

/** Maximum UTF-8 size of the complete reproduction manifest. */
export const REPRODUCTION_MANIFEST_MAX_BYTES = 64 * 1024;

/** Retained facts for one secretless Cloud node-check-v1 run. */
export interface ReproductionManifest {
  version: 1;
  run: { id: string; pipelineId: string };
  repository: { id: string; fullName: string };
  source: {
    commit: string;
    treeSha: string;
    lockfile: { path: "bun.lock"; digest: string };
  };
  nodeCheck: { plan: NodeCheckPlan; digest: string };
  /** Image identity and recorded version metadata. Null means unknown. */
  runtime: {
    imageDigest: string;
    node: string | null;
    bun: string | null;
    tubeless: string | null;
  };
  /** Run-scoped snapshot labels for admitted Vitest checks. */
  diagnostics?: { stepId: string; artifact: string }[];
}

const identifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const githubName = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9_.-]{1,100}$/;
const gitSha = /^[a-f0-9]{40}$/;
const digest = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
const imageDigest = /^sha256:[a-f0-9]{64}$/;
const version = /^[0-9]{1,8}\.[0-9]{1,8}\.[0-9]{1,8}(?:[-+][A-Za-z0-9.+-]{1,64})?$/;

function fields(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!isJsonObject(value) || Object.keys(value).some((key) => !keys.includes(key)))
    throw new TypeError(`Invalid reproduction manifest ${label}.`);
  return value;
}

function match(value: unknown, pattern: RegExp, label: string): string {
  if (typeof value !== "string" || !pattern.test(value))
    throw new TypeError(`Invalid reproduction manifest ${label}.`);
  return value;
}

function recordedVersion(value: unknown, label: string): string | null {
  return value === null ? null : match(value, version, label);
}

/** SHA-256/base64url of UTF-8 JSON with recursively sorted object keys and original array order. */
export async function digestNodeCheckPlan(plan: NodeCheckPlan): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(canonicalJsonValue(plan)));
  const result = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return btoa(String.fromCharCode(...result))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .slice(0, -1);
}

/** Validate a JSON value, normalize its plan and verify the retained digest. Performs no I/O. */
export async function decodeReproductionManifest(value: unknown): Promise<ReproductionManifest> {
  if (!isJsonObject(value) || value.version !== 1)
    throw new TypeError("Unsupported reproduction manifest version. Expected version 1.");
  const manifest = fields(
    value,
    ["version", "run", "repository", "source", "nodeCheck", "runtime", "diagnostics"],
    "fields"
  );
  const run = fields(manifest.run, ["id", "pipelineId"], "run");
  const repository = fields(manifest.repository, ["id", "fullName"], "repository");
  const fullName = match(repository.fullName, githubName, "GitHub repository name");
  if (fullName.endsWith("/.") || fullName.endsWith("/.."))
    throw new TypeError("Invalid reproduction manifest GitHub repository name.");
  const source = fields(manifest.source, ["commit", "treeSha", "lockfile"], "source");
  const lockfile = fields(source.lockfile, ["path", "digest"], "lockfile");
  if (lockfile.path !== "bun.lock")
    throw new TypeError("The reproduction manifest requires a bun.lock identity.");

  const nodeCheck = fields(manifest.nodeCheck, ["plan", "digest"], "nodeCheck");
  const plan = decodeNodeCheckPlan(nodeCheck.plan);
  if (!plan) throw new TypeError("Unsupported reproduction manifest Node check plan.");
  const planDigest = match(nodeCheck.digest, digest, "plan digest");
  const runtime = fields(manifest.runtime, ["imageDigest", "node", "bun", "tubeless"], "runtime");
  const result: ReproductionManifest = {
    version: 1,
    run: {
      id: match(run.id, identifier, "run ID"),
      pipelineId: match(run.pipelineId, identifier, "pipeline ID"),
    },
    repository: { id: match(repository.id, identifier, "repository ID"), fullName },
    source: {
      commit: match(source.commit, gitSha, "source commit"),
      treeSha: match(source.treeSha, gitSha, "source tree SHA"),
      lockfile: { path: "bun.lock", digest: match(lockfile.digest, digest, "lockfile digest") },
    },
    nodeCheck: { plan, digest: planDigest },
    runtime: {
      imageDigest: match(runtime.imageDigest, imageDigest, "image digest"),
      node: recordedVersion(runtime.node, "recorded Node version"),
      bun: recordedVersion(runtime.bun, "recorded Bun version"),
      tubeless: recordedVersion(runtime.tubeless, "recorded Tubeless version"),
    },
  };
  if (manifest.diagnostics !== undefined) {
    const expected = new Set(
      plan.commands.filter(({ kind }) => kind === "vitest").map(({ id }) => id)
    );
    if (!Array.isArray(manifest.diagnostics) || manifest.diagnostics.length > expected.size)
      throw new TypeError("Invalid reproduction manifest diagnostic references.");
    result.diagnostics = manifest.diagnostics.map((value) => {
      const ref = fields(value, ["stepId", "artifact"], "diagnostic reference");
      const stepId = match(ref.stepId, identifier, "diagnostic step ID");
      const artifact = `${stepId}.check-report.json`;
      if (!expected.delete(stepId) || ref.artifact !== artifact)
        throw new TypeError("Invalid reproduction manifest diagnostic reference.");
      return { stepId, artifact };
    });
  }
  if ((await digestNodeCheckPlan(plan)) !== planDigest)
    throw new TypeError("Reproduction manifest Node check plan digest mismatch.");
  return result;
}

/** Parse bounded UTF-8 JSON and validate it without fetching or executing source. */
export async function parseReproductionManifest(
  input: string | Uint8Array
): Promise<ReproductionManifest> {
  if (typeof input === "string" && input.length > REPRODUCTION_MANIFEST_MAX_BYTES)
    throw new TypeError("Reproduction manifest exceeds 64 KiB.");
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  if (bytes.byteLength > REPRODUCTION_MANIFEST_MAX_BYTES)
    throw new TypeError("Reproduction manifest exceeds 64 KiB.");
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new TypeError("Reproduction manifest must be valid UTF-8 JSON.");
  }
  return decodeReproductionManifest(value);
}
