import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { roundTripId, workerChildId } from "../../examples/cloudflare/runner-placement/project.js";
import runnerProject from "../../examples/cloudflare/runner-placement/runner.project.js";
import { runRemote } from "../workbench/workbench-remote.js";
import {
  call,
  getExecution,
  http,
  inWorkerd,
  jsonBody,
  launch,
  restartWorkerd,
  runnerIo,
  runnerPost,
  startFaultRunner,
  runnerDirectory,
  workerFaults,
} from "./cloudflare-runner.test-support.js";

const localResultFile = () => join(runnerDirectory(), "local-result.txt");
const roundTripInput = { text: "local-source.txt" };
const roundTripManifest = {
  [roundTripId]: runnerProject.get(roundTripId).plan().definition!.identity.definitionId,
};
async function prepareRoundTrip(text: string) {
  await call("/_test/seed-worker");
  await rm(localResultFile(), { force: true });
  await writeFile(join(runnerDirectory(), "local-source.txt"), text);
}

async function verifyWorkerChild(runId: string, status: string, dryRun = false) {
  const detail = await (await call(`/api/runs/${runId}`)).json();
  expect(detail.children).toEqual([expect.objectContaining({ status, pipelineId: workerChildId })]);
  const child = await (await call(`/api/runs/${detail.children[0].runId}`)).json();
  expect(child.run).toMatchObject({
    parentRunId: runId,
    parentStepId: "prefix-in-cloudflare",
    dryRun,
  });
  expect(JSON.stringify(child)).toContain("Runner Cloudflare");
  return detail;
}

it("starts a Bun round trip through the CLI or a Worker schedule and carries dry-run controls", async () => {
  await prepareRoundTrip("cli");
  const output: string[] = [];
  expect(
    await runRemote(
      [
        "run",
        roundTripId,
        "--input-file",
        "-",
        "--idempotency-key",
        "reverse-cli",
        "--host",
        http,
        "--detach",
      ],
      {
        ...runnerIo(),
        stdout: {
          write: (text) => {
            output.push(text);
          },
        },
      },
      { fetch: inWorkerd("user"), readStdin: async () => JSON.stringify(roundTripInput) }
    )
  ).toBe(0);
  const cliId = output.join("").trim();
  const enqueueIds: string[] = [];
  const stop = await startFaultRunner(async (reply, url, init) => {
    const response = await reply();
    if (url.pathname.endsWith("/stage-enqueue") && typeof init?.body === "string") {
      const { id, job } = JSON.parse(init.body);
      if (id === cliId) {
        enqueueIds.push(job.id);
        if (enqueueIds.length === 1)
          throw new Error("Lost dispatch reply after Studio enqueues it");
      }
    }
    return response;
  });
  try {
    await vi.waitFor(
      async () => {
        expect(await getExecution(cliId)).toMatchObject({ state: "completed", target: "local" });
      },
      { timeout: 4_000 }
    );
    expect(await readFile(localResultFile(), "utf8")).toBe("prefix:cli");
    expect(enqueueIds).toEqual([expect.any(String), enqueueIds[0]]);
    expect(workerFaults.effects.filter((value) => value === "cli")).toHaveLength(1);
    const root = await verifyWorkerChild((await getExecution(cliId)).runId, "completed");
    expect(root.launch.launchId).toBe(cliId);
    expect(JSON.stringify(root)).toContain("Runner local");

    await prepareRoundTrip("trigger");
    await call("/_test/scheduled?time=42");
    const scheduled = await launch("local-file.42", roundTripId, roundTripInput);
    await vi.waitFor(
      async () => {
        expect(await getExecution(scheduled)).toMatchObject({ state: "completed" });
      },
      { timeout: 4_000 }
    );
    expect(await readFile(localResultFile(), "utf8")).toBe("prefix:trigger");
    await verifyWorkerChild((await getExecution(scheduled)).runId, "completed");

    await prepareRoundTrip("preview-worker");
    const dry = await launch("reverse-dry", roundTripId, { ...roundTripInput, dryRun: true });
    await vi.waitFor(
      async () => {
        expect(await getExecution(dry)).toMatchObject({ state: "completed" });
      },
      { timeout: 4_000 }
    );
    await verifyWorkerChild((await getExecution(dry)).runId, "completed", true);
    await expect(readFile(localResultFile(), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await (await call("/_test/worker-result")).text()).toBe("");
    expect(workerFaults.effects).not.toContain("preview-worker");
  } finally {
    await stop();
  }
});

it("rejects incompatible Worker dispatches before effects and propagates cancellation", async () => {
  await prepareRoundTrip("revision-mismatch");
  const bad = await launch("reverse-mismatch", roundTripId, roundTripInput);
  const old = await runnerPost("claim", { manifest: roundTripManifest, journalVersion: 1 });
  expect(await old.json()).toEqual({
    diagnostic: "Waiting work requires a runner with Worker stage support.",
  });
  let rejected: { status: number; body: unknown } | undefined;
  const stop = await startFaultRunner(async (reply, url, init) => {
    if (url.pathname.endsWith("/stage-enqueue") && typeof init?.body === "string") {
      const body = JSON.parse(init.body);
      if (body.id === bad) {
        body.job.definitionId = "wrong-worker-revision";
        const response = await runnerPost("stage-enqueue", body);
        rejected = { status: response.status, body: await response.clone().json() };
        return response;
      }
    }
    return reply();
  });
  try {
    await vi.waitFor(
      async () => {
        expect(await getExecution(bad)).toMatchObject({ state: "failed" });
      },
      { timeout: 4_000 }
    );
    expect(rejected).toMatchObject({ status: 409 });
    expect(workerFaults.starts).not.toContain(bad);
    expect(workerFaults.effects).not.toContain("revision-mismatch");
    await expect(readFile(localResultFile(), "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    await prepareRoundTrip("cancel-worker");
    const cancelled = await launch("reverse-cancel", roundTripId, roundTripInput);
    await vi.waitFor(
      async () => {
        const { runId } = await getExecution(cancelled);
        const detail = await (await call(`/api/runs/${runId}`)).json();
        expect(detail.children[0]).toMatchObject({ pipelineId: workerChildId, status: "running" });
      },
      { timeout: 4_000 }
    );
    expect(
      await (
        await call(`/api/executions/v1/${cancelled}/cancel`, {
          method: "POST",
          headers: { "x-tubeless-execution": "1" },
        })
      ).json()
    ).toMatchObject({ cancellationRequested: true });
    await vi.waitFor(
      async () => {
        expect(await getExecution(cancelled)).toMatchObject({ state: "cancelled" });
        expect(workerFaults.cancellations).toEqual([true]);
      },
      { timeout: 4_000 }
    );
    await expect(readFile(localResultFile(), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(workerFaults.effects).not.toContain("cancel-worker");
  } finally {
    await stop();
  }
});

it.each([
  {
    text: "worker-effect-committed",
    committed: true,
    state: "completed",
    stageStatus: "completed",
    output: "prefix:worker-effect-committed",
    reason: undefined,
    faultObserved: (id: string) => workerFaults.droppedCompletions.has(id),
  },
  {
    text: "worker-effect-interrupted",
    committed: false,
    state: "outcome_unknown",
    stageStatus: "failed",
    output: undefined,
    reason: "journal_outcome_unknown",
    faultObserved: () => workerFaults.stalledEffects.has("worker-effect-interrupted"),
  },
])(
  "rejoins a Worker stage after restart ($state) and fences the stale Bun lease",
  async ({ text, committed, state, stageStatus, output, reason, faultObserved }) => {
    await prepareRoundTrip(text);
    const key = `reverse-${state}`;
    const id = await launch(key, roundTripId, roundTripInput);
    if (committed) workerFaults.dropCompletions.add(id);
    let previousDispatch: string | undefined;
    const stop = await startFaultRunner(async (reply, url, init) => {
      if (url.pathname.endsWith("/stage-enqueue")) previousDispatch = String(init?.body);
      if (url.pathname.endsWith("/stage-read")) {
        await reply();
        throw new Error("Lost stage observation");
      }
      return reply();
    });
    try {
      await vi.waitFor(
        () => {
          expect(workerFaults.effects.filter((value) => value === text)).toHaveLength(1);
          expect(faultObserved(id)).toBe(true);
        },
        { timeout: 4_000 }
      );
    } finally {
      await stop();
    }
    const original = await getExecution(id);
    expect(original).toMatchObject({ state: "running", runId: expect.any(String) });
    await expect(readFile(localResultFile(), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await restartWorkerd(() => {
      workerFaults.stalledEffects.get(text)?.();
      workerFaults.stalledEffects.delete(text);
      workerFaults.dropCompletions.delete(id);
    });
    const stale = JSON.parse(previousDispatch!);
    const [, wake] = await Promise.all([
      call("/_test/expire-root-lease", jsonBody({ launchId: id })),
      call("/_test/wake-stage", jsonBody({ stageId: stale.job.id })),
    ]);
    expect(wake.ok).toBe(true);
    const staleRequests = await Promise.all([
      runnerPost("stage-enqueue", stale),
      runnerPost("stage-cancel", { id, token: stale.token, stageId: stale.job.id }),
    ]);
    expect(await Promise.all(staleRequests.map((response) => response.json()))).toEqual([
      { accepted: false },
      { accepted: false },
    ]);

    let resumedDispatch: unknown;
    const stopRecovered = await startFaultRunner(async (reply, url, init) => {
      if (url.pathname.endsWith("/stage-enqueue"))
        resumedDispatch = JSON.parse(String(init?.body)).job.id;
      return reply();
    });
    try {
      await vi.waitFor(
        async () => {
          const execution = await getExecution(id);
          expect(execution.state).toBe(state);
          expect(execution.reason).toBe(reason);
        },
        { timeout: 4_000 }
      );
      const after = await getExecution(id);
      expect(await launch(key, roundTripId, roundTripInput)).toBe(id);
      expect(after.runId).not.toBe(original.runId);
      expect(resumedDispatch).toBe(stale.job.id);
      expect(workerFaults.effects.filter((value) => value === text)).toHaveLength(1);
      expect(workerFaults.starts.filter((launchId) => launchId === id)).toHaveLength(1);
      expect(await (await call("/_test/worker-result")).text()).toBe(`prefix:${text}`);
      const localResult = await readFile(localResultFile(), "utf8").catch((error: unknown) => {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
        throw error;
      });
      expect(localResult).toBe(output);
      await verifyWorkerChild(original.runId, stageStatus);
      const recovered = await (await call(`/api/runs/${after.runId}`)).json();
      expect(recovered.launch).toMatchObject({
        launchId: id,
        recoveryRunIds: [after.runId, original.runId],
      });
    } finally {
      await stopRecovered();
    }
  }
);
