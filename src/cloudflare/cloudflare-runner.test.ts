import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Miniflare, NoOpLog, Response as MiniflareResponse } from "miniflare";
import { stripTypeScriptTypes } from "node:module";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import {
  deploymentId,
  transformId,
  runnerServiceId,
} from "../../examples/cloudflare/runner-placement/project.js";
import runnerProject from "../../examples/cloudflare/runner-placement/runner.project.js";
import { manifestModules } from "./cloudflare-workerd.test-support.js";
import { runRemote } from "../workbench/workbench-remote.js";
import { RUNNER_PATH, runnerProjectHeader } from "../hosting/runner-protocol.js";

const projectId = "runner-placement";
const example = (file: string) =>
  new URL(`../../examples/cloudflare/runner-placement/${file}`, import.meta.url);
const AUD = "b".repeat(64);
const ISSUER = "https://runner-test.cloudflareaccess.com";
let runtime: Miniflare;
let recreateRuntime: () => Miniflare;
const holdStageResults = new Set<string>();
let temp: string;
let access: { runner: string; user: string };
const definitionId = runnerProject.pipelines[1].plan().definition!.identity.definitionId;
const manifest = { [transformId]: definitionId };

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
      "export const { TubelessStudio, TubelessRun } = app.durableObjects;",
      `
      const { TubelessStudio: BaseStudio, TubelessRun } = app.durableObjects;
      export { TubelessRun };
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
      if (path === "/_test/seed") {
        await Promise.all([env.TUBELESS_BUCKET.put("source.txt", url.searchParams.get("text") ?? " example text "), env.TUBELESS_BUCKET.delete("published.txt")]);
        return new Response();
      }
      if (path === "/_test/launch") {
        const { id, command, values } = await request.json();
        return Response.json(await app.launch(env, command, values, { idempotencyKey: id, trigger: "schedule" }));
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
                return new MiniflareResponse("Unexpected outbound request.", { status: 502 });
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

function inWorkerd(actor: keyof typeof access) {
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

const http = "http://localhost";
const call = (path: string, init?: RequestInit) => inWorkerd("user")(`${http}${path}`, init);
const jsonBody = (value: unknown) => ({ method: "POST", body: JSON.stringify(value) });
const getExecution = async (id: string) => (await call(`/api/executions/v1/${id}`)).json();
const launch = async (id: string, command: string, values: object): Promise<string> => {
  const receipt = await (await call("/_test/launch", jsonBody({ id, command, values }))).json();
  expect(receipt).toMatchObject({ accepted: true });
  return receipt.launchId;
};
const runnerPost = (
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

it("keeps local launches queued, pins claims, and joins the real mixed example in Studio", async () => {
  await call("/_test/seed");
  const local = await launch("local", transformId, { text: " triggered " });
  const previewLocal = await launch("preview-local", transformId, {
    text: "preview",
    dryRun: true,
  });
  const mixed = await launch("mixed", "fetch-transform-publish", { text: "source.txt" });
  await vi.waitFor(async () =>
    expect(await getExecution(mixed)).toMatchObject({ state: "running" })
  );
  expect(await getExecution(local)).toMatchObject({
    state: "queued",
    target: "local",
    reason: "runner_waiting",
  });
  expect((await runnerPost("claim", { manifest }, "user")).status).toBe(403);
  expect((await inWorkerd("runner")(`${http}/api/executions/v1/${local}`, undefined)).status).toBe(
    403
  );
  expect(await (await runnerPost("claim", { manifest }, "runner", "wrong")).json()).toMatchObject({
    code: "runner_revision_mismatch",
  });
  expect(
    await (await runnerPost("claim", { manifest: { [transformId]: "wrong" } })).json()
  ).toMatchObject({ diagnostic: expect.stringContaining(transformId) });

  expect(await getExecution(local)).toMatchObject({ reason: "runner_incompatible" });

  const out: string[] = [];
  const err: string[] = [];
  const io = {
    cwd: temp,
    stdout: {
      write: (text: string) => {
        out.push(text);
      },
    },
    stderr: {
      write: (text: string) => {
        err.push(text);
      },
    },
  };
  expect(
    await runRemote(
      [
        "run",
        transformId,
        "--input-file",
        "-",
        "--idempotency-key",
        "local",
        "--host",
        http,
        "--detach",
      ],
      io,
      { fetch: inWorkerd("user"), readStdin: async () => JSON.stringify({ text: " triggered " }) }
    )
  ).toBe(0);
  expect(out.join("").trim()).toBe(local);

  const projectFile = join(temp, "runner.ts");
  await writeFile(
    projectFile,
    `export { default } from ${JSON.stringify(example("runner.project.ts").href)};\n`
  );
  const controller = new AbortController();
  let rejectedAttempt = false;
  let stageDeliveries = 0;
  let parentProgress: unknown;
  let committedStageReply: unknown;
  const worker = inWorkerd("runner");
  const fetcher: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (
      path.endsWith("/finish") &&
      typeof init?.body === "string" &&
      JSON.parse(init.body).id === previewLocal
    ) {
      rejectedAttempt = true;
      return Response.json({ message: "Attempt-specific rejection" }, { status: 400 });
    }
    if (
      path.endsWith("/events") &&
      init?.body instanceof Uint8Array &&
      Object.hasOwn(JSON.parse(new TextDecoder().decode(init.body)), "report")
    ) {
      stageDeliveries++;
      if (stageDeliveries === 1) {
        parentProgress = await vi.waitFor(
          async () => {
            const { state, runId } = await getExecution(mixed);
            if (state !== "running") throw new Error("The parent is not running.");
            const detail = await (await call(`/api/runs/${runId}`)).json();
            const step = detail.run.steps.find(
              (step: { id: string }) => step.id === "transform-locally"
            );
            if (!step?.progress?.details) throw new Error("The parent has no child progress.");
            return step;
          },
          { timeout: 2_500 }
        );
        throw new Error("Lost request before commit");
      }
      if (stageDeliveries === 2) {
        committedStageReply = await (await worker(url, init)).json();
        throw new Error("Lost response after commit");
      }
    }
    return worker(url, init);
  };
  const running = runRemote(
    ["runner", "--host", http, "--project", projectFile, "--deployment-id", deploymentId],
    { ...io, signal: controller.signal },
    {
      fetch: fetcher,
      sleep: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      },
    }
  );
  try {
    await vi.waitFor(
      async () => {
        expect(await getExecution(local)).toMatchObject({ state: "completed", target: "local" });
        expect(await getExecution(mixed)).toMatchObject({
          state: "completed",
          target: "cloudflare",
        });
      },
      { timeout: 10_000 }
    );
    expect(rejectedAttempt).toBe(true);
    expect(err.join("")).toContain("Attempt-specific rejection");
    await vi.waitFor(() => expect(stageDeliveries).toBe(3));
    expect(parentProgress).toMatchObject({
      id: "transform-locally",
      status: "running",
      progress: { details: [{ id: "transform", label: "Local file ready" }] },
    });
    expect(committedStageReply).toEqual({ accepted: true });
    expect(await (await call("/_test/published")).text()).toBe("EXAMPLE TEXT");
    expect(await readFile(join(temp, "normalized.txt"), "utf8")).toBe("EXAMPLE TEXT");
    const { runId } = await getExecution(mixed);
    const detail = await (await call(`/api/runs/${runId}`)).json();
    expect(JSON.stringify(detail)).toContain("transform-locally");
    const [stage] = detail.children;
    expect(stage).toMatchObject({ pipelineId: transformId, status: "completed" });
    const stageDetail = await (await call(`/api/runs/${stage.runId}`)).json();
    expect(stageDetail.run).toMatchObject({
      parentRunId: runId,
      parentStepId: "transform-locally",
    });
    expect(JSON.stringify(stageDetail)).toContain("Runner local");
    expect(JSON.stringify(stageDetail)).toContain("Local file transformed");
    expect(JSON.stringify(stageDetail)).toContain("Local file ready");

    const auditFile = join(temp, "normalize-writes.ndjson");
    const writesBeforeDryRun = await readFile(auditFile, "utf8");
    await call("/_test/seed");
    await rm(join(temp, "normalized.txt"));
    const dry = await launch("dry", "fetch-transform-publish", {
      text: "source.txt",
      dryRun: true,
    });
    await vi.waitFor(
      async () => expect(await getExecution(dry)).toMatchObject({ state: "completed" }),
      { timeout: 10_000 }
    );
    await expect(readFile(join(temp, "normalized.txt"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readFile(auditFile, "utf8")).toBe(writesBeforeDryRun);
    expect(await (await call("/_test/published")).text()).toBe("");
  } catch (error) {
    throw new Error(`${String(error)}\nRunner output:\n${err.join("")}`, { cause: error });
  } finally {
    controller.abort();
    expect(await running).toBe(0);
  }
}, 30_000);

it("refuses an invalid result at the owning schema and propagates active cancellation to Bun", async () => {
  const projectFile = join(temp, "slow-runner.ts");
  const abortedFile = join(temp, "abort-confirmed.txt");
  await writeFile(
    projectFile,
    `
    import { writeFile } from "node:fs/promises";
    import { runnerProject } from ${JSON.stringify(example("project.ts").href)};
    export default runnerProject({
      async writeLocal(_cwd, text, signal) {
        if (text === "INVALID") return { unexpected: "schema mismatch" };
        await new Promise(resolve => signal.addEventListener("abort", resolve, { once: true }));
        await writeFile(${JSON.stringify(abortedFile)}, "cancelled");
        throw signal.reason;
      },
    });
  `
  );
  const controller = new AbortController();
  const errors: string[] = [];
  const running = runRemote(
    ["runner", "--host", http, "--project", projectFile, "--deployment-id", deploymentId],
    {
      cwd: temp,
      signal: controller.signal,
      stdout: { write() {} },
      stderr: {
        write(text) {
          errors.push(text);
        },
      },
    },
    {
      fetch: inWorkerd("runner"),
      sleep: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      },
    }
  );
  try {
    await call("/_test/seed?text=invalid");
    const invalid = await launch("invalid", "fetch-transform-publish", { text: "source.txt" });
    await vi.waitFor(
      async () => expect(await getExecution(invalid)).toMatchObject({ state: "failed" }),
      { timeout: 10_000 }
    );
    const invalidRun = await getExecution(invalid);
    const invalidDetail = await (await call(`/api/runs/${invalidRun.runId}`)).json();
    const invalidStage = await (await call(`/api/runs/${invalidDetail.children[0].runId}`)).json();
    expect(invalidStage.run.status).toBe("failed");
    expect(JSON.stringify(invalidStage)).toContain("Expected text.");
    expect(await (await call("/_test/published")).text()).toBe("");

    await call("/_test/seed?text=slow");
    const cancellation = await launch("cancel-active", "fetch-transform-publish", {
      text: "source.txt",
    });
    let childId = "";
    await vi.waitFor(
      async () => {
        const { runId } = await getExecution(cancellation);
        expect(runId).toBeDefined();
        const detail = await (await call(`/api/runs/${runId}`)).json();
        expect(detail.children).toHaveLength(1);
        childId = detail.children[0].runId;
      },
      { timeout: 10_000 }
    );
    const cancel = await call(`/api/executions/v1/${cancellation}/cancel`, {
      method: "POST",
      headers: { "x-tubeless-execution": "1" },
    });
    expect(await cancel.json()).toMatchObject({ cancellationRequested: true });
    await vi.waitFor(
      async () => {
        expect(await getExecution(cancellation)).toMatchObject({ state: "cancelled" });
        expect(await readFile(abortedFile, "utf8")).toBe("cancelled");
      },
      { timeout: 10_000 }
    );
    const cancelledChild = await (await call(`/api/runs/${childId}`)).json();
    expect(["failed", "cancelled"]).toContain(cancelledChild.run.status);
    expect(await (await call("/_test/published")).text()).toBe("");
  } catch (error) {
    throw new Error(`${String(error)}\nRunner output:\n${errors.join("")}`, { cause: error });
  } finally {
    controller.abort();
    expect(await running).toBe(0);
  }
}, 30_000);

function runnerIo(signal?: AbortSignal) {
  return { cwd: temp, signal, stdout: { write() {} }, stderr: { write() {} } };
}

const writeCount = async (text: string) =>
  (await readFile(join(temp, "normalize-writes.ndjson"), "utf8"))
    .trim()
    .split("\n")
    .filter((line) => JSON.parse(line) === text).length;

async function startFaultRunner(
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

function isTerminalBatch(url: URL, init?: RequestInit): boolean {
  return (
    url.pathname.endsWith("/events") &&
    init?.body instanceof Uint8Array &&
    Object.hasOwn(JSON.parse(new TextDecoder().decode(init.body)), "report")
  );
}

it("recreates workerd and the Bun runner after a committed stage loses its response", async () => {
  await call("/_test/seed?text=recovery%20committed");
  const id = await launch("recover-committed", "fetch-transform-publish", { text: "source.txt" });
  holdStageResults.add(id);
  let committed: unknown;
  const stop = await startFaultRunner(async (reply, url, init) => {
    if (!isTerminalBatch(url, init)) return reply();
    if (!committed) {
      committed = await (await reply()).json();
    }
    throw new Error("Drop completion response after Studio commits");
  });
  try {
    await vi.waitFor(() => expect(committed).toEqual({ accepted: true }), { timeout: 10_000 });
  } finally {
    await stop();
  }
  const before = await getExecution(id);
  expect(before).toMatchObject({ state: "running", runId: expect.any(String) });
  expect(await (await call("/_test/published")).text()).toBe("");
  expect(await writeCount("RECOVERY COMMITTED")).toBe(1);

  await runtime.dispose();
  holdStageResults.delete(id);
  runtime = recreateRuntime();
  let duplicateOffers = 0;
  const stopRecreated = await startFaultRunner(async (reply, url) => {
    const response = await reply();
    if (url.pathname.endsWith("/claim") && (await response.clone().json()).claim) duplicateOffers++;
    return response;
  });
  try {
    expect(
      await launch("recover-committed", "fetch-transform-publish", { text: "source.txt" })
    ).toBe(id);
    await vi.waitFor(
      async () => expect(await getExecution(id)).toMatchObject({ state: "completed" }),
      { timeout: 12_000 }
    );
    const after = await getExecution(id);
    expect(after.runId).not.toBe(before.runId);
    expect(await (await call("/_test/published")).text()).toBe("RECOVERY COMMITTED");
    expect(await writeCount("RECOVERY COMMITTED")).toBe(1);
    expect(duplicateOffers).toBe(0);
    const current = await (await call(`/api/runs/${after.runId}`)).json();
    expect(current.launch).toMatchObject({
      launchId: id,
      recoveryRunIds: [after.runId, before.runId],
    });
    const original = await (await call(`/api/runs/${before.runId}`)).json();
    expect(original.children).toEqual([
      expect.objectContaining({ status: "completed", pipelineId: transformId }),
    ]);
  } finally {
    await stopRecreated();
  }
}, 30_000);

it("surfaces an unknown stage after the runner writes and loses its lease before completion", async () => {
  await call("/_test/seed?text=recovery%20uncertain");
  const input = { text: "source.txt" };
  const result: string[] = [];
  expect(
    await runRemote(
      [
        "run",
        "fetch-transform-publish",
        "--input-file",
        "-",
        "--idempotency-key",
        "recover-unknown",
        "--host",
        http,
        "--detach",
      ],
      {
        ...runnerIo(),
        stdout: {
          write: (text) => {
            result.push(text);
          },
        },
      },
      { fetch: inWorkerd("user"), readStdin: async () => JSON.stringify(input) }
    )
  ).toBe(0);
  const id = result.join("").trim();
  expect(await launch("recover-unknown", "fetch-transform-publish", input)).toBe(id);
  let lost: { url: string; init?: RequestInit } | undefined;
  const stop = await startFaultRunner(async (reply, url, init) => {
    if (!isTerminalBatch(url, init)) return reply();
    lost = { url: url.href, init };
    throw new Error("Drop terminal delivery after the filesystem write");
  });
  try {
    await vi.waitFor(() => expect(lost).toBeDefined(), { timeout: 10_000 });
  } finally {
    await stop();
  }
  await runtime.dispose();
  runtime = recreateRuntime();
  const stopRecreated = await startFaultRunner((reply) => reply());
  try {
    await vi.waitFor(
      async () =>
        expect(await getExecution(id)).toMatchObject({
          state: "outcome_unknown",
          reason: "journal_outcome_unknown",
        }),
      { timeout: 22_000 }
    );
    expect(await writeCount("RECOVERY UNCERTAIN")).toBe(1);
    expect(await (await call("/_test/published")).text()).toBe("");
    const stale = lost!;
    expect(await (await inWorkerd("runner")(stale.url, stale.init)).json()).toEqual({
      accepted: false,
    });
    const { runId } = await getExecution(id);
    const detail = await (await call(`/api/runs/${runId}`)).json();
    expect(JSON.stringify(detail)).toContain(`Execution ${id}, stage `);
    expect(JSON.stringify(detail)).toContain("TUBELESS_JOURNAL_OUTCOME_UNKNOWN");
  } finally {
    await stopRecreated();
  }
}, 40_000);

it.each([
  { committed: true, expected: { state: "completed" }, completeReply: { accepted: true } },
  {
    committed: false,
    expected: { state: "outcome_unknown", reason: "journal_outcome_unknown" },
    completeReply: undefined,
  },
])(
  "recovers a Bun root after losing a journal reply (committed=$committed)",
  async ({ committed, expected, completeReply }) => {
    const text = `BUN ROOT ${expected.state.toUpperCase()}`;
    const id = await launch(`root-${expected.state}`, transformId, { text });
    let completion: unknown;
    let lostBegin: string | undefined;
    let committedCompletion: unknown;
    const beginReplies: unknown[] = [];
    const stop = await startFaultRunner(async (reply, url, init) => {
      if (!url.pathname.endsWith("/journal") || typeof init?.body !== "string") return reply();
      const body = JSON.parse(init.body);
      if (body.operation === "begin" && lostBegin === undefined) {
        beginReplies.push(await (await reply()).json());
        lostBegin = init.body;
        throw new Error("Lost begin response");
      }
      if (init.body === lostBegin) {
        const response = await reply();
        beginReplies.push(await response.clone().json());
        return response;
      }
      if (body.operation !== "complete") return reply();
      if (committed) committedCompletion = await (await reply()).json();
      completion = body;
      throw new Error("Lost journal completion reply");
    });
    let originalRunId: string | undefined;
    try {
      await vi.waitFor(() => expect(completion).toBeDefined(), { timeout: 8_000 });
      await vi.waitFor(async () => {
        const current = await getExecution(id);
        expect(current.runId).toEqual(expect.any(String));
        originalRunId = current.runId;
      });
      expect(beginReplies).toEqual([
        { accepted: true, status: "new" },
        { accepted: true, status: "new" },
      ]);
      expect(committedCompletion).toEqual(completeReply);
      expect(await writeCount(text)).toBe(1);
    } finally {
      await stop();
    }

    await runtime.dispose();
    runtime = recreateRuntime();
    const expired = await call("/_test/expire-root-lease", jsonBody({ launchId: id }));
    expect(await expired.json()).toEqual({ expired: true });
    expect(await getExecution(id)).toMatchObject({ state: "queued", reason: "runner_waiting" });
    const stopRecreated = await startFaultRunner((reply) => reply());
    try {
      await vi.waitFor(async () => expect(await getExecution(id)).toMatchObject(expected));
      const current = await getExecution(id);
      expect(current.runId).not.toBe(originalRunId);
      expect(await writeCount(text)).toBe(1);
      expect(await (await runnerPost("journal", completion)).json()).toEqual({ accepted: false });
      const detail = await (await call(`/api/runs/${current.runId}`)).json();
      expect(detail.launch).toMatchObject({
        launchId: id,
        recoveryRunIds: [current.runId, originalRunId],
      });
    } finally {
      await stopRecreated();
    }
  }
);
