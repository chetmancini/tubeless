import { ActivityCancellationType, proxyActivities } from "@temporalio/workflow";
import type * as activities from "./activities.js";

// Only Activity types cross this boundary. Tubeless, Node I/O, and the Activity
// implementation must not enter Temporal's deterministic Workflow bundle.
const { runPipeline } = proxyActivities<typeof activities>({
  startToCloseTimeout: "1 minute",
  scheduleToCloseTimeout: "5 minutes",
  heartbeatTimeout: "15 seconds",
  retry: { initialInterval: "1 second", maximumInterval: "10 seconds", maximumAttempts: 3 },
  cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
});

export async function normalizeWorkflow(job: activities.TemporalJob) {
  return await runPipeline(job);
}
