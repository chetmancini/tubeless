import { isAuthoredPipelineId } from "../core/pipeline-ids.js";
import type { HostedCommand } from "../hosting/hosting-commands.js";
import { boundedRunnerJson, MAX_RUNNER_MANIFEST_PIPELINES } from "../hosting/runner-protocol.js";
import { MAX_RUN_DURATION_MS } from "./cloudflare-run-contract.js";
import type { CloudflareAppOptions } from "./cloudflare.js";

export function maxRunDuration(value: number | undefined): number {
  if (value === undefined) return MAX_RUN_DURATION_MS;
  if (!Number.isInteger(value) || value <= 0 || value > MAX_RUN_DURATION_MS) {
    throw new Error(
      `limits.maxRunDurationMs must be a positive integer no greater than ${MAX_RUN_DURATION_MS}.`
    );
  }
  return value;
}

export function resolveRunnerPlacement(
  commands: ReadonlyMap<string, HostedCommand>,
  deploymentId: string | undefined,
  localRunner: CloudflareAppOptions["localRunner"]
) {
  const runnerService = localRunner?.serviceId;
  let localPipelines: ReadonlyMap<string, string> | undefined;
  let workerChildren: ReadonlyMap<string, string> | undefined;
  const definitionsFor = (ids: readonly string[], placement: string) =>
    new Map(
      ids.map((id) => {
        const identity = commands.get(id)?.command.plan().definition?.identity;
        if (!isAuthoredPipelineId(id) || !identity?.implementationVersion)
          throw new Error(
            `${placement} pipeline ${JSON.stringify(id)} requires a registered, versioned definition.`
          );
        return [id, identity.definitionId];
      })
    );
  if (localRunner !== undefined) {
    if (!deploymentId || !runnerService || runnerService.length > 1024)
      throw new Error("Local runner placement requires deploymentId and an Access serviceId.");
    if (
      localRunner.pipelines.length < 1 ||
      localRunner.pipelines.length > MAX_RUNNER_MANIFEST_PIPELINES
    )
      throw new Error(`Configure 1–${MAX_RUNNER_MANIFEST_PIPELINES} local runner pipelines.`);
    localPipelines = definitionsFor(localRunner.pipelines, "Local runner");
    const children = localRunner.workerChildren ?? [];
    if (children.length > MAX_RUNNER_MANIFEST_PIPELINES)
      throw new Error(`Configure at most ${MAX_RUNNER_MANIFEST_PIPELINES} Worker child pipelines.`);
    if (children.some((id) => localPipelines?.has(id)))
      throw new Error("A Worker child pipeline cannot also be placed on the local runner.");
    if (children.length > 0) {
      workerChildren = definitionsFor(children, "Worker child");
      boundedRunnerJson(Object.fromEntries(workerChildren), "Worker child catalog");
    }
  }
  return { runnerService, localPipelines, workerChildren };
}
