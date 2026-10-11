import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { Miniflare, NoOpLog, type WorkerdStructuredLog } from "miniflare";
import { afterAll, beforeAll, beforeEach, describe, expect, it, onTestFailed } from "vitest";

const dist = fileURLToPath(new URL("../../dist/", import.meta.url));
const AUD = "a".repeat(64);
const ISSUER = "https://test.cloudflareaccess.com";

const WORKER = String.raw`
import { createSteps, definePipeline } from "./core/pipeline.js";
import { defineProject } from "./project/project.js";
import { createCloudflareApp } from "./cloudflare/cloudflare.js";
const schema = (validate, input) => ({ "~standard": { vendor: "test", version: 1, validate, jsonSchema: { input: () => input } } });
const nameInput = { type: "object", properties: { name: { type: "string" } }, required: ["name"] };
const emptyInput = { type: "object", properties: {} };
const greetSteps = createSteps(schema((v) => typeof v?.name === "string" && v.name.length >= 3 ? { value: v } : { issues: [{ message: "Expected at least 3 characters", path: ["name"] }] }, nameInput));
const greet = greetSteps.step("greet", { run: (_i, c) => { c.log.log("hello " + c.options.name); return "hi " + c.options.name; } });
const slowSteps = createSteps(schema((v) => ({ value: v ?? {} }), emptyInput));
const wait = slowSteps.step("wait", { run: (_i, c) => new Promise((resolve, reject) => { const t = setTimeout(resolve, 20000, "done"); c.signal.addEventListener("abort", () => { clearTimeout(t); reject(c.signal.reason); }, { once: true }); }) });
const cachedSteps = createSteps(schema((v) => ({ value: v ?? {} }), emptyInput));
const cached = cachedSteps.step("cached", { cache: { version: "v1" }, run: () => ({ ok: true }) });
const app = createCloudflareApp(defineProject("worker-test", [
  definePipeline({ id: "greeting", name: "Greeting", steps: [greet], finalize: greet }),
  definePipeline({ id: "slow", steps: [wait], finalize: wait }),
  definePipeline({ id: "cached", steps: [cached], finalize: cached }),
]));
export default app.worker;
export const { TubelessStudio, TubelessRun } = app.durableObjects;
`;

function relativeImports(source: string, directory: string): string[] {
  return [...source.matchAll(/(?:\bfrom\s+|\bimport\s*(?:\(\s*)?)["'](\.[^"']+)["']/g)].map(
    (match) => posix.normalize(posix.join(directory, match[1]!))
  );
}

function manifestModules(entry: string): Record<string, { type: "esm"; contents: string }> {
  const modules: Record<string, { type: "esm"; contents: string }> = {
    "worker.js": { type: "esm", contents: entry },
  };
  const pending = relativeImports(entry, "");
  while (pending.length > 0) {
    const name = pending.pop()!;
    if (modules[name]) continue;
    const contents = readFileSync(join(dist, name), "utf8");
    modules[name] = { type: "esm", contents };
    pending.push(...relativeImports(contents, posix.dirname(name)));
  }
  return modules;
}

let mf: Miniflare;
// Worker console output is kept quiet and replayed only for the test that failed.
let workerLogs: string[] = [];
let persist: string;
let keys: CryptoKeyPair;
let jwk: JsonWebKey;

const b64url = (bytes: Uint8Array) => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
};
async function accessToken(): Promise<string> {
  const encode = (value: unknown) => b64url(new TextEncoder().encode(JSON.stringify(value)));
  const head = encode({ alg: "RS256", kid: "k1" });
  const body = encode({
    iss: ISSUER,
    aud: [AUD],
    exp: Math.floor(Date.now() / 1000) + 600,
    email: "ops@example.com",
  });
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    keys.privateKey,
    new TextEncoder().encode(`${head}.${body}`)
  );
  return `${head}.${body}.${b64url(new Uint8Array(signature))}`;
}

interface CallInit {
  readonly method?: string;
  readonly headers?: Record<string, string>;
  readonly body?: string;
}

async function call(path: string, init: CallInit = {}, authenticated = true) {
  const headers = { ...init.headers };
  if (authenticated) headers["cf-access-jwt-assertion"] = await accessToken();
  return mf.dispatchFetch(`http://localhost${path}`, { ...init, headers });
}
const mutation = (extra: Record<string, string>, body?: unknown): CallInit => ({
  method: "POST",
  headers: {
    origin: "http://localhost",
    ...extra,
    ...(body === undefined ? {} : { "content-type": "application/json" }),
  },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const launch = (command: string, values: Record<string, unknown>) =>
  call(`/api/commands/${command}/runs`, mutation({ "x-tubeless-studio-launch": "1" }, { values }));

async function runStatus(runId: string, until: (status: string) => boolean): Promise<string> {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const response = await call(`/api/runs/${encodeURIComponent(runId)}`);
    if (response.status === 200) {
      const status = ((await response.json()) as { run: { status: string } }).run.status;
      if (until(status)) return status;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Run ${runId} did not reach the expected status.`);
}

beforeAll(async () => {
  keys = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"]
  )) as CryptoKeyPair;
  jwk = { ...(await crypto.subtle.exportKey("jwk", keys.publicKey)), kid: "k1" } as JsonWebKey;
  persist = mkdtempSync(join(tmpdir(), "tubeless-workers-"));
  mf = new Miniflare({
    resourcePersistencePath: persist,
    telemetry: { enabled: false },
    log: new NoOpLog(),
    handleStructuredLogs: ({ level, message }: WorkerdStructuredLog) => {
      workerLogs.push(`[${level}] ${message}`);
    },
    workers: [
      {
        config: {
          name: "tubeless-test",
          compatibilityDate: "2026-10-01",
          compatibilityFlags: ["nodejs_compat"],
          manifest: { mainModule: "worker.js", modules: manifestModules(WORKER) },
          env: {
            TUBELESS_STUDIO: {
              type: "durable-object",
              worker: "tubeless-test",
              exportName: "TubelessStudio",
            },
            TUBELESS_RUN: {
              type: "durable-object",
              worker: "tubeless-test",
              exportName: "TubelessRun",
            },
            TUBELESS_BUCKET: { type: "r2", name: "tubeless-test" },
            ACCESS_TEAM_DOMAIN: { type: "text", value: "test.cloudflareaccess.com" },
            ACCESS_AUD: { type: "text", value: AUD },
          },
          exports: {
            TubelessStudio: { type: "durable-object", storage: "sqlite" },
            TubelessRun: { type: "durable-object", storage: "sqlite" },
          },
        },
        dev: {
          outboundService: {
            type: "fetcher",
            handler: async (request: Request) =>
              request.url === `${ISSUER}/cdn-cgi/access/certs`
                ? Response.json({ keys: [jwk] })
                : new Response("Outbound requests are blocked in tests.", { status: 502 }),
          },
        },
      },
    ],
  });
}, 60_000);

afterAll(async () => {
  await mf?.dispose();
  rmSync(persist, { recursive: true, force: true });
});

beforeEach(() => {
  workerLogs = [];
  onTestFailed(() => {
    if (workerLogs.length > 0) console.error(`Worker logs:\n${workerLogs.join("\n")}`);
  });
});

describe("tubeless/cloudflare on workerd", { timeout: 60_000 }, () => {
  it("requires Cloudflare Access", async () => {
    expect((await call("/api/snapshot", {}, false)).status).toBe(401);
    expect((await call("/", {}, false)).status).toBe(403);
  });

  it("serves Studio and the project's commands", async () => {
    const page = await call("/");
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("script-src 'sha256-");
    const { commands } = (await (await call("/api/commands")).json()) as {
      commands: { id: string }[];
    };
    expect(commands.map((command) => command.id)).toEqual(["greeting", "slow", "cached"]);
  });

  it("rejects cross-origin mutations", async () => {
    const response = await call("/api/commands/greeting/runs", {
      ...mutation({ "x-tubeless-studio-launch": "1" }, { values: { name: "ada" } }),
      headers: {
        origin: "https://evil.example",
        "x-tubeless-studio-launch": "1",
        "content-type": "application/json",
      },
    });
    expect(response.status).toBe(403);
  });

  it("launches a run, acknowledges with its id, and records completion and logs", async () => {
    const response = await launch("greeting", { name: "ada" });
    expect(response.status).toBe(202);
    const { runId } = (await response.json()) as { runId: string };
    expect(await runStatus(runId, (status) => status !== "running")).toBe("completed");
    const detail = JSON.stringify(
      await (await call(`/api/runs/${encodeURIComponent(runId)}`)).json()
    );
    expect(detail).toContain("hello ada");
  });

  it("resolves a launch whose command exits before recording a run", async () => {
    const response = await launch("greeting", { name: "ab" });
    const body = (await response.json()) as {
      accepted: boolean;
      runId?: string;
      errors?: string[];
    };
    if (body.accepted)
      expect(await runStatus(body.runId!, (status) => status !== "running")).toBe("failed");
    else
      expect(body.errors?.join("\n")).toMatch(
        /Expected at least 3 characters|before recording a run/
      );
  });

  it("cancels a live run", async () => {
    const { runId } = (await (await launch("slow", {})).json()) as { runId: string };
    const snapshot = (await (await call("/api/snapshot")).json()) as { liveRunIds: string[] };
    expect(snapshot.liveRunIds).toContain(runId);
    const cancel = await call(
      `/api/runs/${encodeURIComponent(runId)}/cancel`,
      mutation({ "x-tubeless-studio-cancel": "1" })
    );
    expect(cancel.status).toBe(202);
    expect(await runStatus(runId, (status) => status !== "running")).toBe("cancelled");
  });

  it("fails a cached step that has no Workers cache store without breaking Studio", async () => {
    const { runId } = (await (await launch("cached", {})).json()) as { runId: string };
    expect(await runStatus(runId, (status) => status !== "running")).toBe("failed");
    expect((await call("/api/snapshot")).status).toBe(200);
  });
});
