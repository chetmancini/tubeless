import { expect, it } from "vitest";
import { deploymentId, transformId } from "../../examples/cloudflare/runner-placement/project.js";
import runnerProject from "../../examples/cloudflare/runner-placement/runner.project.js";
import { createFakeDurableStorage } from "./cloudflare-storage.test-support.js";
import { StudioObjectCore } from "./cloudflare-studio.js";
import { hostedProjectCommands } from "../hosting/hosting-commands.js";
import { RUNNER_LEASE_MS, RUNNER_PATH, runnerProjectHeader } from "../hosting/runner-protocol.js";
import { encodeAttemptBatches, encodeRunnerCompletion } from "../hosting/attempt-batch.js";
import type { PipelineTraceEvent } from "../tracing/tracing.js";
import { PIPELINE_TRACE_VERSION } from "../tracing/tracing-constants.js";

const http = "http://localhost";
const projectId = "runner-placement";
const definitionId = runnerProject.pipelines[1].plan().definition!.identity.definitionId;
const manifest = { [transformId]: definitionId };
const commands = new Map(
  hostedProjectCommands(runnerProject).map((entry) => [entry.descriptor.id, entry])
);

function openStudio(
  storage: ReturnType<typeof createFakeDurableStorage>,
  now: () => number,
  recoverInterruptedRuns = false
) {
  return new StudioObjectCore({
    storage,
    commands,
    localPipelines: new Map(Object.entries(manifest)),
    recoverInterruptedRuns,
    clientScript: "",
    projectId,
    deploymentId,
    maxRunDurationMs: RUNNER_LEASE_MS * 3,
    now,
    runStub: () => ({ start: async () => {}, cancel: () => !recoverInterruptedRuns }),
  });
}

function runnerRequest(op: string, body: unknown, lease?: string): Request {
  return new Request(`${http}${RUNNER_PATH}/${op}`, {
    method: "POST",
    body: body instanceof Uint8Array ? (body as BodyInit) : JSON.stringify(body),
    headers: {
      "x-tubeless-project": runnerProjectHeader(projectId),
      "x-tubeless-deployment": deploymentId,
      ...(lease ? { "x-tubeless-lease": lease } : {}),
    },
  });
}

it("keeps queued local work when upgrading the launch and runner tables", async () => {
  const storage = createFakeDurableStorage();
  const legacy = openStudio(storage, () => 1000);
  const receipt = await legacy.launch({
    projectId,
    deploymentId,
    commandId: transformId,
    idempotencyKey: "queued-before-upgrade",
    values: { text: "waiting" },
  });
  if (!receipt.accepted) throw new Error(receipt.errors.join("\n"));
  storage.sql.exec("ALTER TABLE tubeless_launches DROP COLUMN recovery_generation");
  storage.sql.exec("ALTER TABLE tubeless_runner_queue DROP COLUMN recovery_binding");

  const upgraded = openStudio(storage, () => 1000, true);
  expect(upgraded.getExecution(receipt.launchId)).toMatchObject({
    state: "queued",
    target: "local",
  });
  const response = await upgraded.serveRunner(runnerRequest("claim", { manifest }));
  expect(await response.json()).toMatchObject({
    claim: { job: { launchId: receipt.launchId, run: { values: { text: "waiting" } } } },
  });
});

it("fences duplicate claims and an expired attempt, cancels queued work, and rejects invalid stage results", async () => {
  const storage = createFakeDurableStorage();
  let now = 1000;
  const studio = openStudio(storage, () => now);
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
    studio.serveRunner(runnerRequest(op, body, lease));
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
  expect(studio.readStage(parent, "stage", -1).result).toBeUndefined();
  await studio.cancelStage(parent, "stage");
  expect(
    await (await request("heartbeat", { id: "stage", token: stageClaim.token })).json()
  ).toEqual({ active: true, cancelled: true });
  await request("finish", { id: "stage", token: stageClaim.token, result: "cancelled" });
  expect(studio.readStage(parent, "stage", -1).result).toEqual({
    error: "The remote stage was cancelled.",
  });

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
  const running = events.find((event) => event.name === "step.running");
  if (!running) throw new Error("Expected the stage to start work.");
  const updates = Array.from({ length: 33 }, (_, index) => ({
    ...running,
    payload: { ...running.payload, progress: { completed: index + 1 } },
  }));
  const [progress] = encodeAttemptBatches(
    "complete-stage",
    0,
    events.flatMap<PipelineTraceEvent>((event) =>
      event === running ? [event, ...updates] : [event]
    )
  );
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
  expect(studio.readStage(parent, "complete-stage", -1).result).toBeUndefined();
  expect(statusOfStage()).toBe(0);

  const completion = encodeRunnerCompletion("complete-stage", 1, terminal, report);
  expect(await (await request("events", completion, token)).json()).toEqual({ accepted: true });
  const firstPage = studio.readStage(parent, "complete-stage", -1);
  expect(firstPage).toMatchObject({ hasMore: true });
  expect(firstPage.result).toBeUndefined();
  const finalPage = studio.readStage(parent, "complete-stage", firstPage.events.at(-1)!.id);
  expect(
    [...firstPage.events, ...finalPage.events].flatMap((event) =>
      event.name === "step.running" && event.payload.progress
        ? [event.payload.progress.completed]
        : []
    )
  ).toEqual(updates.map((event) => event.payload.progress.completed));
  expect(finalPage.result).toMatchObject({
    report: { value: "ACTUAL REPORT", status: "completed" },
  });
  expect(statusOfStage()).toBe(1);
  await studio.reportFailure(parent, "Fixture parent done.");
  expect(studio.readStage(parent, "complete-stage", -1).result).toBeUndefined();
  now += RUNNER_LEASE_MS + 1;
  expect(await (await request("events", completion, "wrong-token")).json()).toEqual({
    accepted: false,
  });
  expect((await request("events", terminalWithoutReport, token)).status).toBe(409);
  expect(await (await request("events", completion, token)).json()).toEqual({ accepted: true });
  expect(statusOfStage()).toBe(1);
});

it("fences stage dispatch across generations and honors cancellation after Studio restarts", async () => {
  const storage = createFakeDurableStorage();
  const now = 1000;
  const open = () => openStudio(storage, () => now, true);
  const commandId = "fetch-transform-publish";
  const launch = async (idempotencyKey: string, dryRun = false) => {
    const result = await studio.launch({
      projectId,
      deploymentId,
      commandId,
      idempotencyKey,
      values: { text: "source.txt", dryRun },
    });
    if (!result.accepted) throw new Error(result.errors.join("\n"));
    return result.launchId;
  };
  const studio = open();
  const execution = await launch("recovery");
  // An explicit dry run takes the regular admission path and creates no recovery owner.
  const preview = await launch("preview", true);
  expect(await studio.admit(preview, 1)).toEqual({ admitted: false });
  expect(await studio.admit(preview)).toEqual({ admitted: true });
  expect(
    storage.sql
      .exec("SELECT launch_id FROM tubeless_launches WHERE recovery_generation IS NOT NULL")
      .toArray()
  ).toEqual([{ launch_id: execution }]);
  expect(await studio.admit(execution)).toEqual({ admitted: false });
  expect(await studio.admit(execution, 1)).toEqual({ admitted: true });
  const root: PipelineTraceEvent = {
    name: "pipeline.started",
    version: PIPELINE_TRACE_VERSION,
    runId: "original-root",
    pipelineId: commandId,
    timestampMs: now,
    payload: { stepCount: 3, dryRun: false, planOk: true, targetIds: [] },
  };
  expect(await studio.appendEvents(execution, 0, [root], 1)).toEqual({ accepted: true });
  const stage = {
    kind: "stage" as const,
    id: "stable-stage",
    launchId: execution,
    deploymentId,
    pipelineId: transformId,
    definitionId,
    deadlineAtMs: now + 10_000,
    stage: {
      parentRunId: root.runId,
      stepId: "transform-locally",
      input: { text: "stable" },
      controls: {},
    },
  };
  await studio.enqueueStage(stage, 1);

  const restarted = open();
  expect(await restarted.admit(execution, 2)).toEqual({ admitted: true });
  expect(restarted.getExecution(execution)).toMatchObject({ runId: root.runId, state: "running" });
  expect(await studio.appendEvents(execution, 0, [root], 1)).toEqual({ accepted: false });
  const same = { ...stage, stage: { ...stage.stage, parentRunId: "replacement-root" } };
  await expect(studio.enqueueStage(same, 1)).rejects.toThrow("cannot queue");
  await restarted.enqueueStage(same, 2);
  await expect(
    restarted.enqueueStage({ ...same, stage: { ...same.stage, input: { text: "changed" } } }, 2)
  ).rejects.toThrow("differs from its admitted input");
  expect(storage.sql.exec("SELECT id FROM tubeless_runner_queue").toArray()).toEqual([
    { id: stage.id },
  ]);

  expect(await restarted.cancelExecution(execution)).toMatchObject({ cancellationRequested: true });
  const afterCancel = open();
  expect(await afterCancel.admit(execution, 3)).toEqual({ admitted: false });
  expect(afterCancel.getExecution(execution)).toMatchObject({
    state: "cancelled",
    runId: root.runId,
  });
  const claim = await afterCancel.serveRunner(runnerRequest("claim", { manifest }));
  expect(await claim.json()).toEqual({});
});

it("closes interrupted Worker descendants and lets a leased Bun branch finish after recovery", async () => {
  const storage = createFakeDurableStorage();
  const now = 1000;
  const studio = openStudio(storage, () => now, true);
  const commandId = "fetch-transform-publish";
  const receipt = await studio.launch({
    projectId,
    deploymentId,
    commandId,
    idempotencyKey: "recover-descendants",
    values: { text: "source.txt" },
  });
  if (!receipt.accepted) throw new Error(receipt.errors.join("\n"));
  const { launchId } = receipt;
  expect(await studio.admit(launchId, 1)).toEqual({ admitted: true });
  const root = {
    name: "pipeline.started",
    version: PIPELINE_TRACE_VERSION,
    runId: "worker-root",
    pipelineId: commandId,
    timestampMs: now,
    payload: { stepCount: 3, dryRun: false, planOk: true, targetIds: [] },
  } satisfies PipelineTraceEvent;
  const workerChild = { ...root, runId: "worker-child", parentRunId: root.runId };
  const workerGrandchild = { ...root, runId: "worker-grandchild", parentRunId: workerChild.runId };
  expect(await studio.appendEvents(launchId, 0, [root, workerChild, workerGrandchild], 1)).toEqual({
    accepted: true,
  });
  const stageId = "leased-stage";
  const stepId = "transform-locally";
  const input = { text: "committed after restart" };
  const controls = { dryRun: true };
  await studio.enqueueStage(
    {
      id: stageId,
      kind: "stage",
      launchId,
      deploymentId,
      pipelineId: transformId,
      definitionId,
      deadlineAtMs: now + 10_000,
      stage: { parentRunId: workerChild.runId, stepId, input, controls },
    },
    1
  );
  const claim = await studio.serveRunner(runnerRequest("claim", { manifest }));
  const { token } = (await claim.json()).claim;
  const events: PipelineTraceEvent[] = [];
  const report = await runnerProject.pipelines[1].run(input, controls, {
    parentRunId: workerChild.runId,
    tracing: {
      parentStep: { runId: workerChild.runId, stepId },
      exporter: { export: (event) => void events.push(event) },
    },
  });
  const terminal = events.pop()!;
  if (terminal.name !== "pipeline.completed") throw new Error("Missing Bun terminal event.");
  const bunChild = { ...root, runId: "bun-child", parentRunId: report.runId };
  const batch = encodeAttemptBatches(stageId, 0, [...events, bunChild])[0];
  const recorded = await studio.serveRunner(runnerRequest("events", batch, token));
  expect(await recorded.json()).toEqual({ accepted: true });

  const restarted = openStudio(storage, () => now, true);
  expect(await restarted.admit(launchId, 2)).toEqual({ admitted: true });
  const ended = storage.sql
    .exec(
      "SELECT run_id FROM pipeline_run_events WHERE event_name = 'pipeline.completed' ORDER BY id"
    )
    .toArray()
    .map(({ run_id }) => run_id);
  expect(ended).toEqual([workerGrandchild.runId, workerChild.runId, root.runId]);
  const heartbeat = await restarted.serveRunner(runnerRequest("heartbeat", { id: stageId, token }));
  expect(await heartbeat.json()).toEqual({ active: true, cancelled: false });

  const childEnded = {
    ...terminal,
    runId: bunChild.runId,
    pipelineId: bunChild.pipelineId,
    parentRunId: report.runId,
  };
  const childBatch = encodeAttemptBatches(stageId, 1, [childEnded])[0];
  expect(
    await (await restarted.serveRunner(runnerRequest("events", childBatch, token))).json()
  ).toEqual({ accepted: true });
  const completion = encodeRunnerCompletion(stageId, 2, terminal, report);
  expect(
    await (await restarted.serveRunner(runnerRequest("events", completion, token))).json()
  ).toEqual({ accepted: true });
  expect(restarted.readStage(launchId, stageId, -1).result).toMatchObject({
    report: { status: "completed", value: "COMMITTED AFTER RESTART" },
  });
});
