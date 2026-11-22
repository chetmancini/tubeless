import { PIPELINE_TRACE_VERSION } from "../tracing/tracing-constants.js";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Miniflare, NoOpLog } from "miniflare";
import { stripTypeScriptTypes } from "node:module";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import {
  deploymentId,
  transformId,
  runnerServiceId,
} from "../../examples/cloudflare/runner-placement/project.js";
import runnerProject from "../../examples/cloudflare/runner-placement/runner.project.js";
import { createFakeDurableStorage } from "./cloudflare-storage.test-support.js";
import { manifestModules } from "./cloudflare-workerd.test-support.js";
import { StudioObjectCore } from "./cloudflare-studio.js";
import { runRemote } from "../workbench/workbench-remote.js";
import { hostedProjectCommands } from "../hosting/hosting-commands.js";
import { RUNNER_LEASE_MS, RUNNER_PATH, runnerProjectHeader } from "../hosting/runner-protocol.js";
import { encodeAttemptBatches, encodeRunnerCompletion } from "../hosting/attempt-batch.js";
import type { PipelineTraceEvent } from "../tracing/tracing.js";

const projectId = "runner-placement";
const example = (file: string) =>
  new URL(`../../examples/cloudflare/runner-placement/${file}`, import.meta.url);
const AUD = "b".repeat(64);
const ISSUER = "https://runner-test.cloudflareaccess.com";
let runtime: Miniflare;
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
  const source = (await compile("worker.ts")).replace("export default {", "const worker = {");
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
      return worker.fetch(request, env);
    } };`;
  runtime = new Miniflare({
    telemetry: { enabled: false },
    log: new NoOpLog(),
    workers: [
      {
        config: {
          name: "runner-test",
          compatibilityDate: "2026-10-01",
          manifest: {
            mainModule: "worker.js",
            modules: manifestModules(entry, { "runner-project.js": await compile("project.ts") }),
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
            handler: async (request: Request) =>
              request.url === `${ISSUER}/cdn-cgi/access/certs`
                ? Response.json({ keys: [publicKey] })
                : new Response("Unexpected outbound request.", { status: 502 }),
          },
        },
      },
    ],
  });
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
  const worker = inWorkerd("runner");
  const fetcher: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (
      path.endsWith("/finish") &&
      typeof init?.body === "string" &&
      JSON.parse(init.body).id === local
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
      if (stageDeliveries === 1) throw new Error("Lost request before commit");
      if (stageDeliveries === 2) {
        expect(await (await worker(url, init)).json()).toEqual({ accepted: true });
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

it("fences duplicate claims and an expired attempt, cancels queued work, and rejects invalid stage results", async () => {
  const storage = createFakeDurableStorage();
  const commands = new Map(
    hostedProjectCommands(runnerProject).map((entry) => [entry.descriptor.id, entry])
  );
  const localPipelines = new Map(Object.entries(manifest));
  let now = 1000;
  const studio = new StudioObjectCore({
    storage,
    commands,
    localPipelines,
    clientScript: "",
    projectId,
    deploymentId,
    maxRunDurationMs: RUNNER_LEASE_MS * 3,
    now: () => now,
    runStub: () => ({ start: async () => {}, cancel: () => true }),
  });
  const local = async (id: string, commandId = transformId) => {
    const receipt = await studio.launch({
      idempotencyKey: id,
      projectId,
      deploymentId,
      commandId,
      values: { text: id },
    });
    if (!receipt.accepted) throw new Error(JSON.stringify(receipt));
    return receipt.launchId;
  };
  const request = (op: string, body: unknown, lease?: string) =>
    studio.serveRunner(
      new Request(`${http}${RUNNER_PATH}/${op}`, {
        method: "POST",
        body: body instanceof Uint8Array ? (body as BodyInit) : JSON.stringify(body),
        headers: {
          "x-tubeless-project": runnerProjectHeader(projectId),
          "x-tubeless-deployment": deploymentId,
          ...(lease ? { "x-tubeless-lease": lease } : {}),
        },
      })
    );
  const stopped = await local("cancel-queued");
  await studio.cancelExecution(stopped);
  expect(studio.getExecution(stopped)).toMatchObject({ state: "cancelled" });

  const id = await local("claim-once");
  const attempts = await Promise.all([
    request("claim", { manifest }),
    request("claim", { manifest }),
  ]);
  const claims = (await Promise.all(attempts.map((response) => response.json()))).flatMap(
    (result) => result.claim ?? []
  );
  expect(claims).toHaveLength(1);
  const lease = { id, token: claims[0].token };
  expect(claims[0].job.run.values.text).toBe("claim-once");
  const [claimed] = storage.sql
    .exec("SELECT job_json FROM tubeless_runner_queue WHERE id = ?", id)
    .toArray();
  expect(String(claimed.job_json)).not.toContain("claim-once");
  now += RUNNER_LEASE_MS - 1;
  const cancel = await studio.cancelExecution(id);
  expect(cancel).toMatchObject({ cancellationRequested: true });
  expect(await (await request("heartbeat", lease)).json()).toEqual({
    active: true,
    cancelled: true,
  });
  now += 2;
  expect(await (await request("heartbeat", lease)).json()).toMatchObject({ active: true });
  now += RUNNER_LEASE_MS + 1;
  expect(await (await request("finish", { ...lease, result: null })).json()).toEqual({
    accepted: false,
  });
  await studio.alarm();
  expect(studio.getExecution(id)).toMatchObject({
    state: "outcome_unknown",
    reason: "runner_interrupted",
  });
  expect(await (await request("claim", { manifest })).json()).toEqual({});

  const parent = await local("parent", "fetch-transform-publish");
  expect(await studio.admit(parent)).toEqual({ admitted: true });
  const root: PipelineTraceEvent = {
    name: "pipeline.started",
    version: PIPELINE_TRACE_VERSION,
    runId: "parent",
    pipelineId: "fetch-transform-publish",
    timestampMs: now,
    payload: { stepCount: 3, dryRun: false, planOk: true, targetIds: [] },
  };
  await studio.appendEvents(parent, 0, [root]);
  const stage = {
    parentRunId: "parent",
    stepId: "transform-locally",
    input: { text: "child" },
    controls: {},
  };
  await studio.enqueueStage({
    kind: "stage",
    id: "stage",
    launchId: parent,
    deploymentId,
    pipelineId: transformId,
    definitionId,
    deadlineAtMs: now + 10_000,
    stage,
  });
  const stageClaim = (await (await request("claim", { manifest })).json()).claim;
  const unrelated: PipelineTraceEvent = { ...root, runId: "forged", pipelineId: transformId };
  expect(
    (await request("events", encodeAttemptBatches("stage", 0, [unrelated])[0], stageClaim.token))
      .status
  ).toBe(409);
  expect(
    (await request("finish", { id: "stage", token: stageClaim.token, result: { value: "forged" } }))
      .status
  ).toBe(400);
  expect(studio.readStage(parent, "stage")).toBeUndefined();
  await studio.cancelStage(parent, "stage");
  expect(
    await (await request("heartbeat", { id: "stage", token: stageClaim.token })).json()
  ).toEqual({ active: true, cancelled: true });
  await request("finish", { id: "stage", token: stageClaim.token, result: "cancelled" });
  expect(studio.readStage(parent, "stage")).toEqual({ error: "The remote stage was cancelled." });

  await studio.enqueueStage({
    kind: "stage",
    id: "complete-stage",
    launchId: parent,
    deploymentId,
    pipelineId: transformId,
    definitionId,
    deadlineAtMs: now + 45_000,
    stage: { ...stage, controls: { dryRun: true } },
  });
  const completionClaim = (await (await request("claim", { manifest })).json()).claim;
  const token = completionClaim.token;
  const events: PipelineTraceEvent[] = [];
  const report = await runnerProject.pipelines[1].run(
    { text: "actual report" },
    { dryRun: true },
    {
      parentRunId: root.runId,
      tracing: {
        parentStep: { runId: root.runId, stepId: stage.stepId },
        exporter: {
          export(event) {
            events.push(event);
          },
        },
      },
    }
  );
  const terminal = events.pop()!;
  expect(terminal.name).toBe("pipeline.completed");
  const progress = encodeAttemptBatches("complete-stage", 0, events)[0];
  expect(await (await request("events", progress, token)).json()).toEqual({ accepted: true });
  const statusOfStage = () =>
    storage.sql
      .exec(
        "SELECT COUNT(*) AS completions FROM pipeline_run_events WHERE run_id = ? AND event_name = 'pipeline.completed'",
        report.runId
      )
      .toArray()[0].completions;
  const terminalWithoutReport = encodeAttemptBatches("complete-stage", 1, [terminal])[0];
  expect((await request("events", terminalWithoutReport, token)).status).toBe(400);
  expect(
    (
      await request(
        "events",
        encodeRunnerCompletion("complete-stage", 1, terminal, {
          ...report,
          dryRun: false,
        }),
        token
      )
    ).status
  ).toBe(400);
  expect(studio.readStage(parent, "complete-stage")).toBeUndefined();
  expect(statusOfStage()).toBe(0);

  const completion = encodeRunnerCompletion("complete-stage", 1, terminal, report);
  expect(await (await request("events", completion, token)).json()).toEqual({ accepted: true });
  expect(studio.readStage(parent, "complete-stage")).toMatchObject({
    report: { value: "ACTUAL REPORT", status: "completed" },
  });
  expect(statusOfStage()).toBe(1);
  await studio.reportFailure(parent, "Fixture parent done.");
  expect(studio.readStage(parent, "complete-stage")).toBeUndefined();
  now += RUNNER_LEASE_MS + 1;
  expect(await (await request("events", completion, "wrong-token")).json()).toEqual({
    accepted: false,
  });
  expect((await request("events", terminalWithoutReport, token)).status).toBe(409);
  expect(await (await request("events", completion, token)).json()).toEqual({ accepted: true });
  expect(statusOfStage()).toBe(1);
});
