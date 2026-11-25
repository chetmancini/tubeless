import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { deploymentId, transformId } from "../../examples/cloudflare/runner-placement/project.js";
import runnerProject from "../../examples/cloudflare/runner-placement/runner.project.js";
import { runRemote } from "../workbench/workbench-remote.js";
import {
  call,
  example,
  getExecution,
  holdStageResults,
  http,
  inWorkerd,
  jsonBody,
  launch,
  restartWorkerd,
  runnerIo,
  runnerPost,
  startFaultRunner,
  runnerDirectory,
} from "./cloudflare-runner.test-support.js";

const definitionId = runnerProject.get(transformId).plan().definition!.identity.definitionId;
const manifest = { [transformId]: definitionId };

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
    cwd: runnerDirectory(),
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

  const projectFile = join(runnerDirectory(), "runner.ts");
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
    expect(await readFile(join(runnerDirectory(), "normalized.txt"), "utf8")).toBe("EXAMPLE TEXT");
    const { runId } = await getExecution(mixed);
    const detail = await (await call(`/api/runs/${runId}`)).json();
    expect(JSON.stringify(detail)).toContain("transform-locally");
    const [stage] = detail.children;
    expect(stage).toMatchObject({ pipelineId: transformId, status: "completed" });
    const followPath = `/api/executions/v1/${mixed}/events`;
    expect((await inWorkerd("runner")(`${http}${followPath}`, undefined)).status).toBe(403);
    const stream = await call(followPath);
    expect(stream.headers.get("content-type")).toBe("application/x-ndjson");
    const frames = (await stream.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(frames[0]).toMatchObject({ type: "snapshot", cursor: 0, executionId: mixed });
    expect(frames).toContainEqual(
      expect.objectContaining({
        type: "log",
        payload: expect.objectContaining({
          runId: stage.runId,
          parentRunId: runId,
          pipelineId: transformId,
          message: "Local file transformed",
        }),
      })
    );
    expect(frames).toContainEqual(
      expect.objectContaining({
        type: "progress",
        payload: expect.objectContaining({
          runId: stage.runId,
          attemptId: expect.any(String),
          message: "Local file ready",
        }),
      })
    );
    expect(frames.at(-1)).toMatchObject({ type: "terminal", payload: { state: "completed" } });
    const stageDetail = await (await call(`/api/runs/${stage.runId}`)).json();
    expect(stageDetail.run).toMatchObject({
      parentRunId: runId,
      parentStepId: "transform-locally",
    });
    expect(JSON.stringify(stageDetail)).toContain("Runner local");
    expect(JSON.stringify(stageDetail)).toContain("Local file transformed");
    expect(JSON.stringify(stageDetail)).toContain("Local file ready");

    const auditFile = join(runnerDirectory(), "normalize-writes.ndjson");
    const writesBeforeDryRun = await readFile(auditFile, "utf8");
    await call("/_test/seed");
    await rm(join(runnerDirectory(), "normalized.txt"));
    const dry = await launch("dry", "fetch-transform-publish", {
      text: "source.txt",
      dryRun: true,
    });
    await vi.waitFor(
      async () => expect(await getExecution(dry)).toMatchObject({ state: "completed" }),
      { timeout: 10_000 }
    );
    await expect(readFile(join(runnerDirectory(), "normalized.txt"), "utf8")).rejects.toMatchObject(
      {
        code: "ENOENT",
      }
    );
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
  const projectFile = join(runnerDirectory(), "slow-runner.ts");
  const abortedFile = join(runnerDirectory(), "abort-confirmed.txt");
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
      cwd: runnerDirectory(),
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

const writeCount = async (text: string) =>
  (await readFile(join(runnerDirectory(), "normalize-writes.ndjson"), "utf8"))
    .trim()
    .split("\n")
    .filter((line) => JSON.parse(line) === text).length;

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

  await restartWorkerd(() => holdStageResults.delete(id));
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
  await restartWorkerd();
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

    await restartWorkerd();
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
