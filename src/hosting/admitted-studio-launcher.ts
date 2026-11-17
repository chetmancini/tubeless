import type { PipelineRunStudioLauncher } from "../studio/shared/protocol.js";
import type {
  HostedLaunchDecision,
  HostedLaunchRequest,
  HostedLaunchStatus,
} from "./launch-admission.js";
import type { HostedRunCoordinator } from "./run-coordinator.js";

/** Browser launches share durable admission, then wait for their root history record. */
export function admittedStudioLauncher(input: {
  coordinator: HostedRunCoordinator;
  projectId: string;
  deploymentId: string | undefined;
  admit(request: HostedLaunchRequest): Promise<HostedLaunchDecision>;
  getLaunch(launchId: string): Promise<HostedLaunchStatus | undefined>;
}): PipelineRunStudioLauncher {
  const { coordinator } = input;
  return {
    commands: coordinator.commands,
    plan: coordinator.plan.bind(coordinator),
    cancel: coordinator.cancel.bind(coordinator),
    liveRunIds: coordinator.liveRunIds.bind(coordinator),
    async launch(commandId, values, context) {
      let decision: HostedLaunchDecision;
      try {
        decision = await input.admit({
          commandId,
          values,
          projectId: input.projectId,
          deploymentId: input.deploymentId,
          idempotencyKey: context?.idempotencyKey ?? crypto.randomUUID(),
          context: { actor: context?.actor, trigger: "manual" },
        });
      } catch {
        return { accepted: false, errors: ["The run host could not start the run."] };
      }
      if (!decision.accepted) return { accepted: false, errors: decision.errors };
      // Register before dispatch or reading history: either can race a committed start/failure.
      const acknowledged = coordinator.waitForStart(decision.launchId);
      if (decision.job) void coordinator.startPrepared(decision.job, decision.job);
      else {
        try {
          const status = await input.getLaunch(decision.launchId);
          if (status?.runId)
            coordinator.acknowledge(decision.launchId, { accepted: true, runId: status.runId });
          else if (status?.state === "failed")
            coordinator.acknowledge(decision.launchId, {
              accepted: false,
              errors: [
                "The run host could not confirm the run started. It may have started; check history before launching again.",
              ],
            });
        } catch {
          coordinator.acknowledge(decision.launchId, {
            accepted: false,
            errors: [
              "The run host could not read launch state. It may have started; check history before launching again.",
            ],
          });
        }
      }
      return acknowledged;
    },
  };
}
