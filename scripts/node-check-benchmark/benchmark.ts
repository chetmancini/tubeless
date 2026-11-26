import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { parseArgs } from "node:util";
import packageJson from "../../package.json" with { type: "json" };
import { ObservationTimeout, runHosted, verifyCloudPrincipal } from "./cloud.ts";
import { checkpointSample, withTrial, readSamples, recoveryIntent } from "./ledger.ts";
import { runLocal } from "./local.ts";
import { resolveCloudHost } from "../../dist/workbench/cloud/config.js";
import { newSample, type Sample } from "./sample.ts";
import { summarize } from "./summary.ts";
import { controlId, expectedOutcome, selectWorkload } from "./workload.ts";

const usage = [
  "Usage: bun --no-env-file scripts/node-check-benchmark/benchmark.ts",
  "  local <new-trial-directory> <pass|assertion-failure> [--workload <id>] [--timeout-ms <ms>]",
  "  cloud <new-trial-directory> <pass|assertion-failure> [--workload <id>] --workspace <id> --pipeline <id> [--host <origin>] [--timeout-ms <ms>]",
  "  resume <trial-directory> [--timeout-ms <ms>]",
  "  replay <trial-directory> [--timeout-ms <ms>]",
  "  summarize <campaign-or-trial-directory>",
].join("\n");

class UsageError extends Error {}

async function observe(directory: string, sample: Sample) {
  const interrupts = new AbortController();
  const deadline = AbortSignal.timeout(sample.observation.deadlineMs);
  const signal = AbortSignal.any([interrupts.signal, deadline]);
  const interrupt = () => interrupts.abort();
  const checkpoint = () => checkpointSample(directory, sample);
  await checkpoint();
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  try {
    if (sample.mode !== "local") {
      sample.target.principalId = await verifyCloudPrincipal(sample.target, signal);
      await runHosted(sample, signal, checkpoint);
    } else {
      await runLocal(sample, signal, checkpoint);
    }
    sample.observation.state = "observed";
  } catch (error) {
    sample.observation.state = interrupts.signal.aborted
      ? "cancelled"
      : deadline.aborted || error instanceof ObservationTimeout
        ? "timeout"
        : "error";
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
  }
  await checkpoint();
  // Print only fixed classifications and safe identifiers. Command output stays in memory.
  console.log(
    JSON.stringify({
      attemptId: sample.attemptId,
      invocationId: sample.invocationId,
      stage: sample.observation.stage,
      state: sample.observation.state,
      outcome: sample.execution.outcome,
    })
  );
  if (sample.observation.state !== "observed") return 2;
  return sample.execution.outcome === expectedOutcome(sample.workload.variant) ? 0 : 2;
}

async function main() {
  const {
    positionals: [command, directory, variant, ...rest],
    values,
  } = parseArgs({
    allowPositionals: true,
    options: {
      host: { type: "string" },
      workload: { type: "string" },
      workspace: { type: "string" },
      pipeline: { type: "string" },
      "timeout-ms": { type: "string" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log(usage);
    return 0;
  }
  if (!directory || rest.length) throw new UsageError();
  const timeout = Number(values["timeout-ms"] ?? "1500000");
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 1500000) throw new UsageError();
  if (command === "summarize") {
    if (variant || Object.keys(values).length) throw new UsageError();
    console.log(JSON.stringify(summarize(await readSamples(directory, true)), null, 2));
    return 0;
  }
  const driverBun = process.versions.bun;
  if (!driverBun) throw new UsageError();
  const tools = { driverBun, driverTubeless: packageJson.version };
  if (command === "local" || command === "cloud") {
    const selected = selectWorkload(values.workload ?? controlId, variant ?? "");
    if (!selected) throw new UsageError();
    const attemptId = randomUUID();
    const intent = { attemptId, workload: selected, operation: "start" as const };
    let sample: Sample;
    if (command === "cloud") {
      if (!values.workspace || !values.pipeline) throw new UsageError();
      sample = newSample(
        {
          ...intent,
          mode: "cloud",
          target: {
            host: resolveCloudHost(values.host),
            workspace: values.workspace,
            pipelineId: values.pipeline,
            idempotencyKey: "node-check-bench:" + attemptId,
            principalId: null,
          },
        },
        tools,
        timeout,
        null
      );
    } else {
      if (values.host || values.workspace || values.pipeline) throw new UsageError();
      sample = newSample({ ...intent, mode: "local", target: null }, tools, timeout, null);
    }
    await mkdir(directory, { mode: 0o700 });
    return withTrial(directory, () => observe(directory, sample));
  }
  if (command !== "resume" && command !== "replay") throw new UsageError();
  if (
    variant ||
    values.workload !== undefined ||
    values.host ||
    values.workspace ||
    values.pipeline
  )
    throw new UsageError();
  return withTrial(directory, async () => {
    const { runId, ...intent } = recoveryIntent(
      await readSamples(directory, false),
      command,
      Date.now()
    );
    return observe(directory, newSample({ ...intent, operation: command }, tools, timeout, runId));
  });
}

try {
  process.exitCode = await main();
} catch (error) {
  // Avoid printing subprocess errors, CLI arguments, paths or remote text.
  console.error(
    error instanceof UsageError
      ? usage
      : "Benchmark request failed. Check arguments, trial directory, ledger and recovery requirements."
  );
  process.exitCode = 1;
}
