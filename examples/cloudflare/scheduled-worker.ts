import { createCloudflareApp } from "tubeless/cloudflare";
import project from "./tubeless.project.ts";

// Replace this with an immutable release/commit id; change it with execution code or configuration.
const app = createCloudflareApp(project, { deploymentId: "example-v1" });

export default {
  ...app.worker,
  // Configure the cron trigger in your Cloudflare deployment. Await admission, not completion.
  async scheduled(event: { scheduledTime: number }, env: unknown): Promise<void> {
    const admission = await app.launch(
      env,
      "validated-import",
      { source: "daily.csv" },
      { idempotencyKey: `validated-import.daily.${event.scheduledTime}` }
    );
    if (!admission.accepted) throw new Error(`${admission.code}: ${admission.errors.join("; ")}`);
    console.log(`Admitted launch ${admission.launchId}`);
  },
};
export const { TubelessStudio, TubelessRun } = app.durableObjects;
