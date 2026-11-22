import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Miniflare, NoOpLog } from "miniflare";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import type {
  CloudflareLaunchResult,
  CloudflareLaunchStatus,
  CloudflareLaunchValues,
} from "./cloudflare.js";
import { manifestModules } from "./cloudflare-workerd.test-support.js";
import { runRemote } from "../workbench/workbench-remote.js";

const WORKER = String.raw`
import { env } from "cloudflare:workers";
import { createSteps, definePipeline } from "./core/pipeline.js";
import { defineProject } from "./project/project.js";
import { createCloudflareApp } from "./cloudflare/cloudflare.js";
const schema = { "~standard": { vendor: "test", version: 1,
  validate: value => ({ value }),
  jsonSchema: { input: () => ({ type: "object", properties: { name: { type: "string" } }, required: ["name"] }) },
} };
const { step } = createSteps(schema);
const effect = step("effect", { run: async (_inputs, context) => {
  const key = "effect/" + context.options.name;
  const previous = await env.TUBELESS_BUCKET.get(key);
  const count = previous ? Number(await previous.text()) : 0;
  await env.TUBELESS_BUCKET.put(key, String(count + 1));
  return count + 1;
} });
const project = defineProject("launch-test", [definePipeline({ id: "count", steps: [effect] })]);
const app = createCloudflareApp(project, { deploymentId: env.DEPLOYMENT_ID, recordInputs: { count: ["name"] } });
// Test-only entry simulates a trusted application trigger.
export default { async fetch(request, env) {
  const url = new URL(request.url);
  if (url.pathname === "/_test/launch") {
    const { key, values, actor, trigger } = await request.json();
    return Response.json(await app.launch(env, "count", values, { idempotencyKey: key, actor, trigger }));
  }
  if (url.pathname === "/_test/status")
    return Response.json(await app.getLaunch(env, url.searchParams.get("id")) ?? null);
  if (url.pathname === "/_test/effect")
    return new Response(await (await env.TUBELESS_BUCKET.get("effect/" + url.searchParams.get("name")))?.text() ?? "0");
  if (url.pathname === "/_test/unconfigured")
    return Response.json(await createCloudflareApp(project).launch(env, "count", { name: "unused" }, { idempotencyKey: "unused" }));
  return app.worker.fetch(request, env);
} };
export const { TubelessStudio, TubelessRun } = app.durableObjects;
`;

let runtime: Miniflare;
let persist: string;
function createRuntime(deploymentId: string) {
  return new Miniflare({
    resourcePersistencePath: persist,
    telemetry: { enabled: false },
    log: new NoOpLog(),
    workers: [
      {
        config: {
          name: "launch-test",
          compatibilityDate: "2026-10-01",
          compatibilityFlags: ["nodejs_compat"],
          manifest: { mainModule: "worker.js", modules: manifestModules(WORKER) },
          env: {
            TUBELESS_STUDIO: {
              type: "durable-object",
              worker: "launch-test",
              exportName: "TubelessStudio",
            },
            TUBELESS_RUN: {
              type: "durable-object",
              worker: "launch-test",
              exportName: "TubelessRun",
            },
            TUBELESS_BUCKET: { type: "r2", name: "launch-test" },
            DEPLOYMENT_ID: { type: "text", value: deploymentId },
          },
          exports: {
            TubelessStudio: { type: "durable-object", storage: "sqlite" },
            TubelessRun: { type: "durable-object", storage: "sqlite" },
          },
        },
      },
    ],
  });
}
beforeAll(() => {
  persist = mkdtempSync(join(tmpdir(), "tubeless-launch-"));
  runtime = createRuntime("release-1");
});
afterAll(async () => {
  try {
    await runtime?.dispose();
  } finally {
    rmSync(persist, { recursive: true, force: true });
  }
});
async function launch(
  key: string,
  values: CloudflareLaunchValues
): Promise<CloudflareLaunchResult> {
  const response = await runtime.dispatchFetch("http://localhost/_test/launch", {
    method: "POST",
    body: JSON.stringify({ key, values }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as CloudflareLaunchResult;
}
async function status(id: string): Promise<CloudflareLaunchStatus> {
  return (await (
    await runtime.dispatchFetch(`http://localhost/_test/status?id=${id}`)
  ).json()) as CloudflareLaunchStatus;
}

it("admits once over RPC, survives a full workerd restart, and conflicts after redeployment", async () => {
  const [receipt, duplicate] = await Promise.all([
    launch("daily.1", { name: "daily" }),
    launch("daily.1", { maxConcurrency: 1, name: "daily" }),
  ]);
  expect(duplicate).toEqual(receipt);
  if (!receipt.accepted) throw new Error(JSON.stringify(receipt));
  await vi.waitFor(
    async () =>
      expect(await status(receipt.launchId)).toMatchObject({
        state: "finished",
        runId: expect.any(String),
      }),
    { timeout: 10_000 }
  );
  expect(
    await (await runtime.dispatchFetch("http://localhost/_test/effect?name=daily")).text()
  ).toBe("1");
  await runtime.dispose();
  runtime = createRuntime("release-1");
  expect(await launch("daily.1", { name: "daily" })).toEqual(receipt);
  expect(await status(receipt.launchId)).toMatchObject({ state: "finished" });
  const original = await status(receipt.launchId);
  const metadata = await (
    await runtime.dispatchFetch(`http://localhost/api/runs/${encodeURIComponent(original.runId!)}`)
  ).json();
  expect(metadata).toMatchObject({
    launch: {
      commandId: "count",
      trigger: "code",
      inputs: { recorded: [{ key: "name", value: "daily" }] },
    },
  });
  const attributed = (await (
    await runtime.dispatchFetch("http://localhost/_test/launch", {
      method: "POST",
      body: JSON.stringify({
        key: "queue.1",
        values: { name: "queue" },
        actor: { id: "worker", kind: "service" },
        trigger: "queue",
      }),
    })
  ).json()) as CloudflareLaunchResult;
  if (!attributed.accepted) throw new Error("Expected admission");
  await vi.waitFor(
    async () => expect(await status(attributed.launchId)).toMatchObject({ state: "finished" }),
    { timeout: 10_000 }
  );
  const attributedStatus = await status(attributed.launchId);
  expect(
    await (
      await runtime.dispatchFetch(
        `http://localhost/api/runs/${encodeURIComponent(attributedStatus.runId!)}`
      )
    ).json()
  ).toMatchObject({ launch: { actor: { id: "worker", kind: "service" }, trigger: "queue" } });
  await runtime.dispose();
  runtime = createRuntime("release-2");
  expect(await launch("daily.1", { name: "daily" })).toMatchObject({
    accepted: false,
    code: "idempotency_conflict",
    launchId: receipt.launchId,
  });
  const next = await launch("daily.2", { name: "daily" });
  if (!next.accepted) throw new Error(JSON.stringify(next));
  expect(next.launchId).not.toBe(receipt.launchId);
  await vi.waitFor(
    async () => expect(await status(next.launchId)).toMatchObject({ state: "finished" }),
    { timeout: 10_000 }
  );
  expect(
    await (await runtime.dispatchFetch("http://localhost/_test/effect?name=daily")).text()
  ).toBe("2");
}, 60_000);

it("requires deployment identity and preserves the Studio mutation guards", async () => {
  expect(
    await (await runtime.dispatchFetch("http://localhost/_test/unconfigured")).json()
  ).toMatchObject({ accepted: false, code: "invalid_launch" });
  expect((await runtime.dispatchFetch("http://localhost/api/launches")).status).toBe(404);
  expect(
    (
      await runtime.dispatchFetch("http://localhost/api/launches", {
        method: "POST",
        headers: { origin: "http://localhost" },
      })
    ).status
  ).toBe(405);
  expect(
    (
      await runtime.dispatchFetch("http://localhost/api/commands/count/runs", {
        method: "POST",
        body: JSON.stringify({ values: { name: "forged" } }),
        headers: {
          origin: "https://foreign.example",
          "content-type": "application/json",
          "x-tubeless-studio-launch": "1",
        },
      })
    ).status
  ).toBe(403);
}, 30_000);

it("shares the execution identity and history between the CLI and a Worker trigger", async () => {
  let output = "";
  let errors = "";
  const io = {
    cwd: persist,
    stdout: {
      write: (line: string) => {
        output += line;
      },
    },
    stderr: {
      write: (line: string) => {
        errors += line;
      },
    },
  };
  const trigger = await launch("shared-origin", { name: "shared-origin" });
  if (!trigger.accepted) throw new Error("Expected Worker admission");
  const dependencies = {
    fetch: (async (url, init) => {
      const response = await runtime.dispatchFetch(String(url), {
        method: init?.method,
        headers: Object.fromEntries(new Headers(init?.headers)),
        body: typeof init?.body === "string" ? init.body : undefined,
      });
      return new Response(await response.text(), { status: response.status });
    }) satisfies typeof fetch,
    readStdin: async () => JSON.stringify({ name: "shared-origin" }),
  };
  const host = ["--host", "http://localhost", "--json"];
  expect(
    await runRemote(
      [
        "run",
        "count",
        ...host,
        "--input-file",
        "-",
        "--idempotency-key",
        "shared-origin",
        "--detach",
      ],
      io,
      dependencies
    )
  ).toBe(0);
  expect(JSON.parse(output)).toEqual({ executionId: trigger.launchId });
  output = "";
  expect(await runRemote(["status", trigger.launchId, ...host, "--follow"], io, dependencies)).toBe(
    0
  );
  expect(JSON.parse(output)).toMatchObject({
    executionId: trigger.launchId,
    state: "completed",
    runId: expect.any(String),
  });
  expect(errors).toBe("");
  expect(
    await (await runtime.dispatchFetch("http://localhost/_test/effect?name=shared-origin")).text()
  ).toBe("1");
}, 30_000);
