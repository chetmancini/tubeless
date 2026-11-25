import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Miniflare, NoOpLog, Response as MiniflareResponse } from "miniflare";
import { stripTypeScriptTypes } from "node:module";
import { afterAll, beforeAll, expect } from "vitest";
import {
  deploymentId,
  runnerServiceId,
} from "../../examples/cloudflare/runner-placement/project.js";
import { manifestModules } from "./cloudflare-workerd.test-support.js";
import { runRemote } from "../workbench/workbench-remote.js";
import { RUNNER_PATH, runnerProjectHeader } from "../hosting/runner-protocol.js";

const projectId = "runner-placement";
export const example = (file: string) =>
  new URL(`../../examples/cloudflare/runner-placement/${file}`, import.meta.url);
const AUD = "b".repeat(64);
const ISSUER = "https://runner-test.cloudflareaccess.com";
let runtime: Miniflare;
let recreateRuntime: () => Miniflare;
export const holdStageResults = new Set<string>();
export const workerFaults = {
  dropCompletions: new Set<string>(),
  droppedCompletions: new Set<string>(),
  effects: [] as string[],
  cancellations: [] as boolean[],
  stalledEffects: new Map<string, () => void>(),
  starts: [] as string[],
};
let temp: string;
export const runnerDirectory = () => temp;
let access: { runner: string; user: string };

async function compile(file: string) {
  const replacements = new Map([
    ["tubeless", "./core/pipeline.js"],
    ["tubeless/cloudflare", "./cloudflare/cloudflare.js"],
    ["tubeless/project", "./project/project.js"],
    ["./project.ts", "./runner-project.js"],
  ]);
  const source = await readFile(example(file), "utf8");
  return stripTypeScriptTypes(
    source.replace(/from "([^"]+)"/g, (match, id: string) =>
      replacements.has(id) ? `from "${replacements.get(id)}"` : match
    )
  );
}

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
async function sign(key: CryptoKey, claims: Record<string, unknown>) {
  const payload = {
    iss: ISSUER,
    aud: [AUD],
    exp: Math.floor(Date.now() / 1000) + 600,
    ...claims,
  };
  const unsigned = `${b64(Buffer.from(JSON.stringify({ alg: "RS256", kid: "runner" })))}.${b64(Buffer.from(JSON.stringify(payload)))}`;
  return `${unsigned}.${b64(new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, Buffer.from(unsigned))))}`;
}

beforeAll(async () => {
  temp = await mkdtemp(join(tmpdir(), "tubeless-local-runner-"));
  const keys = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"]
  );
  const publicKey = { ...(await crypto.subtle.exportKey("jwk", keys.publicKey)), kid: "runner" };
  access = {
    runner: await sign(keys.privateKey, { sub: "", common_name: runnerServiceId }),
    user: await sign(keys.privateKey, { sub: "user" }),
  };
  const source = (await compile("worker.ts"))
    .replace("export default {", "const worker = {")
    .replace(
      '    if (!dryRun) await bucket.put("worker-result.txt", result);',
      `
      if (text === "cancel-worker") {
        await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
        await fetch("https://fixture.test/worker-cancelled");
        signal.throwIfAborted();
      }
      if (!dryRun) {
        await bucket.put("worker-result.txt", result);
        await fetch("https://fixture.test/worker-effect?value=" + encodeURIComponent(text));
      }
    `
    )
    .replace(
      "export const { TubelessStudio, TubelessRun } = app.durableObjects;",
      `
      const { TubelessStudio: BaseStudio, TubelessRun: BaseRun } = app.durableObjects;
      export class TubelessRun extends BaseRun {
        async wakeStage() {
          const stage = await this.ctx.storage.get("workerStage");
          if (stage && stage.state !== "finished") await this.ctx.storage.setAlarm(Date.now());
        }
        async start(job) {
          if (job.kind === "stage") await fetch("https://fixture.test/worker-start?launch=" + job.launchId);
          return super.start(job);
        }
      }
      export class TubelessStudio extends BaseStudio {
        constructor(state, env) {
          super(state, env);
          this.storage = state.storage;
        }
        async expireRootLease(launchId) {
          this.storage.sql.exec(
            "UPDATE tubeless_runner_queue SET lease_until_ms = 0 WHERE id = ? AND recovery_attempt_id IS NOT NULL",
            launchId
          );
          await super.alarm();
        }
        async appendWorkerStage(job, bytes) {
          const ack = await super.appendWorkerStage(job, bytes);
          const batch = JSON.parse(new TextDecoder().decode(bytes));
          if (ack.accepted && batch.report) {
            const gate = await fetch("https://fixture.test/worker-completion?launch=" + job.launchId);
            if (gate.status === 423) throw new Error("Lost Worker completion reply");
          }
          return ack;
        }
        async readStage(launchId, id, afterId) {
          const observation = await super.readStage(launchId, id, afterId);
          if (!observation.result) return observation;
          const gate = await fetch("https://fixture.test/stage-result?launch=" + launchId);
          return gate.status === 423 ? { events: observation.events } : observation;
        }
      }`
    );
  const entry =
    source +
    String.raw`
    export default { async fetch(request, env) {
      const url = new URL(request.url);
      const path = url.pathname;
      if (path === "/_test/published") return new Response(await (await env.TUBELESS_BUCKET.get("published.txt"))?.text());
      if (path === "/_test/worker-result") return new Response(await (await env.TUBELESS_BUCKET.get("worker-result.txt"))?.text());
      if (path === "/_test/seed-worker") {
        await Promise.all([env.TUBELESS_BUCKET.put("prefix.txt", "prefix:"), env.TUBELESS_BUCKET.delete("worker-result.txt")]);
        return new Response();
      }
      if (path === "/_test/seed") {
        await Promise.all([env.TUBELESS_BUCKET.put("source.txt", url.searchParams.get("text") ?? " example text "), env.TUBELESS_BUCKET.delete("published.txt")]);
        return new Response();
      }
      if (path === "/_test/launch") {
        const { id, command, values } = await request.json();
        return Response.json(await app.launch(env, command, values, { idempotencyKey: id, trigger: "schedule" }));
      }
      if (path === "/_test/scheduled") {
        await worker.scheduled({ scheduledTime: Number(url.searchParams.get("time")) }, env);
        return new Response();
      }
      if (path === "/_test/wake-stage") {
        const { stageId } = await request.json();
        await env.TUBELESS_RUN.getByName("stage:" + stageId).wakeStage();
        return new Response();
      }
      if (path === "/_test/expire-root-lease") {
        const { launchId } = await request.json();
        await env.TUBELESS_STUDIO.getByName("default").expireRootLease(launchId);
        return Response.json({ expired: true });
      }
      return worker.fetch(request, env);
    } };`;
  const fixtureModules = manifestModules(entry, {
    "runner-project.js": await compile("project.ts"),
  });
  recreateRuntime = () =>
    new Miniflare({
      resourcePersistencePath: join(temp, "workerd"),
      telemetry: { enabled: false },
      log: new NoOpLog(),
      workers: [
        {
          config: {
            name: "runner-test",
            compatibilityDate: "2026-10-01",
            manifest: {
              mainModule: "worker.js",
              modules: fixtureModules,
            },
            env: {
              TUBELESS_STUDIO: {
                type: "durable-object",
                worker: "runner-test",
                exportName: "TubelessStudio",
              },
              TUBELESS_RUN: {
                type: "durable-object",
                worker: "runner-test",
                exportName: "TubelessRun",
              },
              TUBELESS_BUCKET: { type: "r2", name: "runner-test" },
              ACCESS_TEAM_DOMAIN: { type: "text", value: "runner-test.cloudflareaccess.com" },
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
              handler: async (request) => {
                if (request.url === `${ISSUER}/cdn-cgi/access/certs`)
                  return MiniflareResponse.json({ keys: [publicKey] });
                const url = new URL(request.url);
                if (url.hostname === "fixture.test" && url.pathname === "/stage-result")
                  return new MiniflareResponse(null, {
                    status: holdStageResults.has(url.searchParams.get("launch")!) ? 423 : 200,
                  });
                if (url.hostname === "fixture.test" && url.pathname === "/worker-completion") {
                  const id = url.searchParams.get("launch")!;
                  if (workerFaults.dropCompletions.has(id)) {
                    workerFaults.droppedCompletions.add(id);
                    return new MiniflareResponse(null, { status: 423 });
                  }
                }
                if (url.hostname === "fixture.test" && url.pathname === "/worker-effect") {
                  const value = url.searchParams.get("value")!;
                  workerFaults.effects.push(value);
                  if (value === "worker-effect-interrupted")
                    await new Promise<void>((resolve) =>
                      workerFaults.stalledEffects.set(value, resolve)
                    );
                }
                if (url.hostname === "fixture.test" && url.pathname === "/worker-cancelled")
                  workerFaults.cancellations.push(true);
                if (url.hostname === "fixture.test" && url.pathname === "/worker-start")
                  workerFaults.starts.push(url.searchParams.get("launch")!);
                return url.hostname === "fixture.test"
                  ? new MiniflareResponse(null)
                  : new MiniflareResponse("Unexpected outbound request.", { status: 502 });
              },
            },
          },
        },
      ],
    });
  runtime = recreateRuntime();
}, 30_000);

afterAll(async () => {
  await runtime?.dispose();
  if (temp) await rm(temp, { recursive: true, force: true });
});

export function inWorkerd(actor: keyof typeof access) {
  return (async (url, init) => {
    const headers = new Headers(init?.headers);
    headers.set("cf-access-jwt-assertion", access[actor]);
    const out = await runtime.dispatchFetch(String(url), {
      method: init?.method,
      headers: Object.fromEntries(headers),
      body:
        init?.body instanceof Uint8Array
          ? Buffer.from(init.body)
          : (init?.body as string | undefined),
    });
    return new Response(await out.arrayBuffer(), {
      status: out.status,
      headers: Object.fromEntries(out.headers),
    });
  }) satisfies typeof fetch;
}

export const http = "http://localhost";
export const call = (path: string, init?: RequestInit) => inWorkerd("user")(`${http}${path}`, init);
export const jsonBody = (value: unknown) => ({ method: "POST", body: JSON.stringify(value) });
export const getExecution = async (id: string) => (await call(`/api/executions/v1/${id}`)).json();
export const launch = async (id: string, command: string, values: object): Promise<string> => {
  const receipt = await (await call("/_test/launch", jsonBody({ id, command, values }))).json();
  expect(receipt).toMatchObject({ accepted: true });
  return receipt.launchId;
};
export const runnerPost = (
  operation: string,
  data: unknown,
  actor: keyof typeof access = "runner",
  revision = deploymentId
) =>
  inWorkerd(actor)(`${http}${RUNNER_PATH}/${operation}`, {
    ...jsonBody(data),
    headers: {
      "x-tubeless-project": runnerProjectHeader(projectId),
      "x-tubeless-deployment": revision,
    },
  });

export function runnerIo(signal?: AbortSignal) {
  return { cwd: temp, signal, stdout: { write() {} }, stderr: { write() {} } };
}

export async function startFaultRunner(
  intercept: (reply: () => Promise<Response>, url: URL, init?: RequestInit) => Promise<Response>
) {
  const projectFile = join(temp, "fault-runner.ts");
  await writeFile(
    projectFile,
    `export { default } from ${JSON.stringify(example("runner.project.ts").href)};\n`
  );
  const controller = new AbortController();
  const runner = inWorkerd("runner");
  const running = runRemote(
    ["runner", "--host", http, "--project", projectFile, "--deployment-id", deploymentId],
    runnerIo(controller.signal),
    {
      fetch: (url, init) => intercept(() => runner(url, init), new URL(String(url)), init),
      sleep: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      },
    }
  );
  return async () => {
    controller.abort();
    expect(await running).toBe(0);
  };
}

export async function restartWorkerd(afterStop?: () => void) {
  await runtime.dispose();
  afterStop?.();
  runtime = recreateRuntime();
}
