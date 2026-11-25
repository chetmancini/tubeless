import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  isCloudAutomationToken,
  parseCliRun,
  type CliRun,
} from "../../dist/workbench/cloud/protocol.js";
import { createCloudClient, isCloudTransportError } from "../../dist/workbench/cloud/client.js";
import { isJsonObject } from "../../dist/utilities/canonical-json.js";
import { digestNodeCheckPlan } from "tubeless/reproduction-manifest";
import { hostedMeasurements, identifier } from "./measurements.ts";
import { checkOutcome } from "./workload.ts";
import { matchesHostedIdentity, type Checkpoint, type CloudSample, type Target } from "./sample.ts";

const bin = fileURLToPath(new URL("../../dist/workbench/workbench-bin.js", import.meta.url));

export class ObservationTimeout extends Error {}

export async function verifyCloudPrincipal(target: Target, signal: AbortSignal): Promise<string> {
  const token = process.env.TUBELESS_TOKEN;
  if (!token || !isCloudAutomationToken(token))
    throw new Error("An automation token with read and run access is required.");
  const client = createCloudClient({ host: target.host, token, signal });
  const access = await client.automation(target.workspace).catch((error: unknown) => {
    if (isCloudTransportError(error) && error.code === "timeout")
      throw new ObservationTimeout("Cloud principal verification timed out.");
    throw error;
  });
  if (!access.scopes.includes("read") || !access.scopes.includes("run"))
    throw new Error("Cloud automation principal lacks required access.");
  if (target.principalId !== null && access.principalId !== target.principalId)
    throw new Error("Cloud replay and recovery require the original automation principal.");
  return identifier.decode(access.principalId, "Cloud principal ID");
}

type CliResponse = { exitCode: number; body: unknown };
type Invoke = (args: string[], signal: AbortSignal) => Promise<CliResponse>;

function followTimedOut(stderr: string): boolean {
  for (const line of stderr.split("\n")) {
    if (!line.startsWith("{")) continue;
    let diagnostic: unknown;
    try {
      diagnostic = JSON.parse(line);
    } catch {
      // The CLI may write ordinary stderr alongside structured diagnostics.
      continue;
    }
    if (
      isJsonObject(diagnostic) &&
      diagnostic.type === "cloud_follow_error" &&
      isJsonObject(diagnostic.error) &&
      diagnostic.error.code === "observation_timeout"
    )
      return true;
  }
  return false;
}

const invokeCloudCli: Invoke = (args, signal) =>
  new Promise((resolve, reject) => {
    execFile(
      process.versions.bun ? process.execPath : "bun",
      ["--no-env-file", bin, "cloud", ...args],
      {
        signal,
        env: { PATH: process.env.PATH, TUBELESS_TOKEN: process.env.TUBELESS_TOKEN },
        maxBuffer: 8 * 1024 * 1024,
        killSignal: "SIGKILL",
      },
      (error, stdout, stderr) => {
        if (signal.aborted) return reject(new Error("Cloud observation was stopped."));
        const exitCode = error?.code ?? 0;
        if (typeof exitCode !== "number")
          return reject(new Error("Cloud CLI could not return a response."));
        try {
          resolve({ exitCode, body: JSON.parse(stdout) as unknown });
        } catch {
          const failure = followTimedOut(stderr)
            ? new ObservationTimeout("Cloud CLI observation timed out.")
            : new Error("Cloud CLI returned no usable JSON.");
          reject(failure);
        }
      }
    );
  });

function terminal(run: CliRun) {
  if (run.status !== "completed" && run.status !== "failed" && run.status !== "cancelled")
    throw new Error("Cloud observation returned a nonterminal run.");
  return run.status;
}

function classify(run: CliRun): CloudSample["execution"]["outcome"] {
  const status = terminal(run);
  if (isJsonObject(run) && run.interrupted === true && status === "failed") return "interrupted";
  return checkOutcome(
    status,
    run.diagnostics?.reports.find(({ artifact }) => artifact === "test.check-report.json")?.result
  );
}

async function inspectIdentity(sample: CloudSample, run: CliRun): Promise<void> {
  const source = run.sourceIdentity;
  const plan = run.nodeCheck;
  const expected = sample.workload;
  if (
    !source ||
    !isJsonObject(source.repository) ||
    !isJsonObject(source.lockfile) ||
    !plan ||
    source.repository.fullName !== expected.repository ||
    source.commit !== expected.commit ||
    source.treeSha !== expected.treeSha ||
    source.lockfile.path !== "bun.lock" ||
    source.lockfile.digest !== expected.lockfileDigest ||
    plan.digest !== expected.planDigest ||
    (await digestNodeCheckPlan(plan.plan)) !== expected.planDigest
  ) {
    sample.execution.identity = "mismatch";
    throw new Error("Cloud inspection does not match the pinned workload.");
  }

  const evidence = isJsonObject(run) ? run.hostedMeasurements : undefined;
  if (evidence !== undefined) {
    const measured = hostedMeasurements.decode(evidence, "hostedMeasurements");
    if (!matchesHostedIdentity(measured, expected, plan.imageDigest)) {
      sample.execution.identity = "mismatch";
      throw new Error("Cloud measurement identity conflicts with retained inspection.");
    }
    const outcome = measured.outcome;
    if (
      outcome !== null &&
      (outcome === "interrupted" || outcome === "timed_out" ? "failed" : outcome) !== run.status
    )
      throw new Error("Cloud measurement outcome conflicts with retained inspection.");
    if (outcome === "timed_out") sample.execution.outcome = "timed-out";
    if (outcome === "interrupted") sample.execution.outcome = "interrupted";
    sample.hostedMeasurements = measured;
  }
  sample.execution.imageDigest = plan.imageDigest;
  sample.execution.identity = "verified";
}

export async function runHosted(
  sample: CloudSample,
  signal: AbortSignal,
  checkpoint: Checkpoint,
  invoke = invokeCloudCli
): Promise<void> {
  const target = sample.target;
  if (!target.principalId) throw new Error("Cloud benchmark principal is missing.");
  if ((sample.operation === "resume") !== (sample.execution.runId !== null))
    throw new Error("Cloud observation recovery requires a retained run ID.");
  const options = ["--host", target.host, "--workspace", target.workspace, "--json"];
  const call = async (args: string[], exitCodes: number[]) => {
    signal.throwIfAborted();
    const response = await invoke([...args, ...options], signal);
    if (!exitCodes.includes(response.exitCode)) throw new Error("Cloud CLI request failed.");
    const run = parseCliRun(response.body);
    identifier.decode(run.id, "Cloud run ID");
    if (
      run.pipelineId !== target.pipelineId ||
      (sample.execution.runId && run.id !== sample.execution.runId)
    )
      throw new Error("Cloud response identity conflicts with the request.");
    return run;
  };
  const start = performance.now();
  if (!sample.execution.runId) {
    sample.observation.stage = "submit";
    await checkpoint();
    const receipt = await call(
      [
        "run",
        "--id",
        target.pipelineId,
        "--source",
        JSON.stringify({ kind: "main", commit: sample.workload.commit }),
        "--idempotency-key",
        target.idempotencyKey,
        "--detach",
      ],
      [0]
    );
    // Persist the receipt before validating source or making another network call.
    sample.execution.runId = receipt.id;
    sample.observation.admissionMs = performance.now() - start;
    await checkpoint();
    if (receipt.commit !== sample.workload.commit) {
      sample.execution.identity = "mismatch";
      throw new Error("Cloud admitted a different commit.");
    }
  }
  const runId = sample.execution.runId;
  sample.observation.stage = "follow";
  await checkpoint();
  const observed = await call(["follow", runId, "--poll"], [0, 6, 7]);
  const observedAt = performance.now();
  sample.execution.outcome = classify(observed);
  if (sample.operation === "start") sample.observation.terminalMs = observedAt - start;
  sample.observation.stage = "inspect";
  await checkpoint();
  const inspected = await call(["inspect", runId], [0]);
  if (
    inspected.status !== observed.status ||
    observed.commit !== sample.workload.commit ||
    inspected.commit !== sample.workload.commit
  ) {
    sample.execution.identity = "mismatch";
    throw new Error("Cloud inspection conflicts with the observed run.");
  }
  sample.execution.outcome = classify(inspected);
  await inspectIdentity(sample, inspected);
}
