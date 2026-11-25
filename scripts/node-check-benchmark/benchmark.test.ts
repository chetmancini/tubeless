import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { expect, it, vi } from "vitest";
import captures from "../fixtures/node-check-benchmark/c7-miniflare.json" with { type: "json" };
import { runHosted, verifyCloudPrincipal } from "./cloud.ts";
import { recoveryIntent } from "./ledger.ts";
import { newSample, readSample, type Sample } from "./sample.ts";
import { summarize } from "./summary.ts";
import { workload, type Variant } from "./workload.ts";

const tools = { driverBun: "1.4.4", driverTubeless: "0.4.7" };
const token = "tlc_ci_v1.fixture-only-bearer";
const workspace = "automation-workspace";
const principalId = "fixture-principal";

function localSample(variant: Variant, ms: number) {
  const sample = newSample(
    {
      attemptId: randomUUID(),
      workload: workload(variant),
      mode: "local",
      operation: "start",
      target: null,
    },
    tools,
    1000,
    null
  );
  sample.tools.node = "24.22.3";
  sample.tools.bun = "1.4.4";
  sample.observation.stage = "execute";
  sample.observation.state = "observed";
  sample.observation.terminalMs = ms;
  sample.execution = {
    runId: randomUUID(),
    identity: "verified",
    imageDigest: null,
    outcome: variant === "pass" ? "passed" : "assertion-failure",
  };
  return sample;
}

function cloudSample(host: string, variant: Variant, capture: (typeof captures)[number]) {
  const { sourceIdentity, nodeCheck, pipelineId } = capture.inspection;
  const attemptId = randomUUID();
  return newSample(
    {
      attemptId,
      mode: "cloud-fixture",
      operation: "start",
      workload: {
        ...workload(variant),
        repository: sourceIdentity.repository.fullName,
        commit: sourceIdentity.commit,
        treeSha: sourceIdentity.treeSha,
        lockfileDigest: sourceIdentity.lockfile.digest,
        planDigest: nodeCheck.digest,
      },
      target: {
        host,
        workspace,
        pipelineId,
        idempotencyKey: "node-check-bench:" + attemptId,
        principalId: null,
      },
    },
    tools,
    10_000,
    null
  );
}

it.each([
  { variant: "pass", capture: captures[0], outcome: "passed" },
  { variant: "assertion-failure", capture: captures[1], outcome: "assertion-failure" },
] as const)(
  "runs the Cloud CLI against captured C7 $variant HTTP responses",
  async ({ variant, capture, outcome }) => {
    vi.stubEnv("TUBELESS_TOKEN", token);
    const requests: {
      path: string | undefined;
      key: string | string[] | undefined;
      body: string;
    }[] = [];
    const base = "/api/v1/workspaces/" + workspace;
    const server = createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += String(chunk);
      requests.push({ path: req.url, key: req.headers["idempotency-key"], body });
      res.setHeader("content-type", "application/json");
      if (req.headers.authorization !== "Bearer " + token) {
        res.writeHead(401).end("{}");
      } else if (req.url === base + "/automation") {
        res.end(JSON.stringify({ workspaceId: workspace, principalId, scopes: ["read", "run"] }));
      } else if (req.method === "POST" && req.url === base + "/runs") {
        res.writeHead(202).end(JSON.stringify(capture.admission));
      } else if (req.url === base + "/runs/" + capture.inspection.id) {
        res.end(JSON.stringify(capture.inspection));
      } else res.writeHead(404).end("{}");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing replay address.");
      const sample = cloudSample("http://127.0.0.1:" + address.port, variant, capture);
      const target = sample.target;
      const signal = new AbortController().signal;
      target.principalId = await verifyCloudPrincipal(target, signal);
      await expect(
        verifyCloudPrincipal({ ...target, principalId: "different-principal" }, signal)
      ).rejects.toThrow("original automation principal");
      const recorded: Sample[] = [];
      await runHosted(sample, signal, () => {
        recorded.push(structuredClone(sample));
        return Promise.resolve();
      });
      sample.observation.state = "observed";
      const snapshot = readSample(sample);
      expect(snapshot.execution).toMatchObject({
        identity: "verified",
        outcome,
        runId: capture.inspection.id,
      });
      expect(snapshot.hostedMeasurements).toEqual(capture.inspection.hostedMeasurements);
      expect(() =>
        readSample({
          ...snapshot,
          hostedMeasurements: {
            ...snapshot.hostedMeasurements,
            phases: { ...snapshot.hostedMeasurements?.phases, providerStartup: { durationMs: -1 } },
          },
        })
      ).toThrow("sample.hostedMeasurements");
      const projection = capture.inspection.hostedMeasurements;
      expect(() =>
        readSample({
          ...snapshot,
          hostedMeasurements: {
            ...projection,
            identity: { ...projection.identity, sourceCommit: "f".repeat(40) },
          },
        })
      ).toThrow("Cloud measurement identity conflicts with sample workload");
      expect(JSON.stringify(snapshot)).not.toContain(token);
      expect(recorded[1].execution.runId).toBe(capture.admission.id);
      expect(requests.map(({ path }) => path)).toEqual([
        base + "/automation",
        base + "/automation",
        base + "/runs",
        base + "/runs/" + capture.inspection.id,
        base + "/runs/" + capture.inspection.id,
      ]);
      expect(requests[2].key).toBe(target.idempotencyKey);
      expect(JSON.parse(requests[2].body)).toEqual({
        pipelineId: target.pipelineId,
        input: {},
        source: { kind: "main", commit: sample.workload.commit },
      });
      expect(summarize([snapshot]).groups[0]).toMatchObject({
        eligible: 0,
        excluded: { fixture: 1 },
        outcomes: { [outcome]: 1 },
      });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
      vi.unstubAllEnvs();
    }
  }
);

it("preserves uncertain attempts and reuses the exact intent until a run ID is known", async () => {
  const capture = captures[0];
  const sample = cloudSample("https://cloud.tubeless.io", "pass", capture);
  // Recovery allows only live-mode ledgers, with pinned workload identities.
  sample.mode = "cloud";
  sample.workload = workload("pass");
  sample.target.principalId = principalId;
  const signal = new AbortController().signal;
  const checkpoint = () => Promise.resolve();
  const missing = vi.fn(() => Promise.reject(new Error("submission acknowledgement lost")));
  await expect(runHosted(sample, signal, checkpoint, missing)).rejects.toThrow(
    "acknowledgement lost"
  );
  sample.observation.state = "error";
  expect(readSample(sample).execution.runId).toBeNull();
  const now = Date.parse(sample.startedAt) + 1000;
  expect(() => recoveryIntent([sample], "resume", now)).toThrow("uncertain");
  expect(() => recoveryIntent([sample], "replay", now + 3600000)).toThrow("closed");
  const { runId, ...intent } = recoveryIntent([sample], "replay", now);
  const retry = newSample({ ...intent, operation: "replay" }, tools, 10_000, runId);
  const accepted = vi
    .fn()
    .mockResolvedValueOnce({
      exitCode: 0,
      body: { ...capture.admission, commit: workload("pass").commit },
    })
    .mockRejectedValueOnce(new Error("observation timed out"));
  await expect(runHosted(retry, signal, checkpoint, accepted)).rejects.toThrow("timed out");
  retry.observation.state = "timeout";
  expect(accepted.mock.calls[0]).toEqual(missing.mock.calls[0]);
  expect(retry.execution.runId).toBe(capture.admission.id);
  expect(() => recoveryIntent([sample, retry], "replay", now)).toThrow("Use resume");
  const { runId: retainedId, ...next } = recoveryIntent([sample, retry], "resume", now);
  const resume = newSample({ ...next, operation: "resume" }, tools, 10_000, retainedId);
  const follow = vi.fn(() => Promise.reject(new Error("observation stopped")));
  await expect(runHosted(resume, signal, checkpoint, follow)).rejects.toThrow(
    "observation stopped"
  );
  expect(follow).toHaveBeenCalledWith(
    expect.arrayContaining(["follow", capture.admission.id]),
    signal
  );
  expect(resume.observation.terminalMs).toBeNull();
});

it("validates measurements and reports repeatable counts, medians and timeout exclusions", () => {
  const fast = localSample("pass", 2);
  const slow = localSample("pass", 6);
  const timedOut = localSample("pass", 30);
  timedOut.observation.state = "timeout";
  timedOut.observation.terminalMs = null;
  timedOut.execution.outcome = "unknown";
  const failure = localSample("assertion-failure", 5);
  const recipeTimeout = localSample("assertion-failure", 8);
  recipeTimeout.execution.outcome = "timed-out";
  expect(() => readSample({ ...fast, version: 2 })).toThrow("sample.version");
  expect(() =>
    readSample({ ...fast, observation: { ...fast.observation, terminalMs: Number.NaN } })
  ).toThrow("sample.observation.terminalMs");
  expect(() =>
    readSample({ ...fast, workload: { ...fast.workload, commit: "a".repeat(40) } })
  ).toThrow("differs from the pinned workload");
  expect(() => summarize([fast, fast])).toThrow("Duplicate benchmark sample");

  const raw = [fast, slow, timedOut, failure, recipeTimeout].map(readSample);
  const summary = summarize(raw);
  expect(summary).toMatchObject({ invocations: 5, trials: 5 });
  expect(summary.groups).toContainEqual(
    expect.objectContaining({
      invocations: 3,
      eligible: 2,
      excluded: { timeout: 1 },
      outcomes: { passed: 2, unknown: 1 },
      distributionsMs: {
        "client.terminal": { n: 2, unknown: 0, min: 2, median: 4, max: 6 },
        "local.preparation": { n: 0, unknown: 2, min: null, median: null, max: null },
        "local.recipe": { n: 0, unknown: 2, min: null, median: null, max: null },
      },
    })
  );
  expect(summary.groups).toContainEqual(
    expect.objectContaining({
      outcomes: { "assertion-failure": 1, "timed-out": 1 },
      excluded: { "unexpected-outcome": 1 },
      eligible: 1,
    })
  );
  expect(summarize([...raw].reverse())).toEqual(summary);
});
