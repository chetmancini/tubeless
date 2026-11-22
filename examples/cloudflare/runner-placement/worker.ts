import { env } from "cloudflare:workers";
import { createCloudflareApp } from "tubeless/cloudflare";
import { deploymentId, runnerProject, runnerServiceId, transformId } from "./project.ts";

interface Bindings {
  readonly TUBELESS_BUCKET: {
    get(key: string): Promise<{ text(): Promise<string> } | null>;
    put(key: string, value: string): Promise<unknown>;
  };
}
const { TUBELESS_BUCKET: bucket } = env as Bindings;
const project = runnerProject({
  async fetch(key) {
    const input = await bucket.get(key);
    if (!input) throw new Error("Input object is missing.");
    return input.text();
  },
  async publish(text) {
    await bucket.put("published.txt", text);
  },
});

const app = createCloudflareApp(project, {
  deploymentId,
  localRunner: { serviceId: runnerServiceId, pipelines: [transformId] },
});
export default {
  ...app.worker,
  async scheduled(event: { scheduledTime: number }, env: unknown): Promise<void> {
    const receipt = await app.launch(
      env,
      "fetch-transform-publish",
      { text: "source.txt" },
      {
        idempotencyKey: `import.${event.scheduledTime}`,
        trigger: "schedule",
      }
    );
    if (!receipt.accepted) throw new Error(receipt.errors.join("\n"));
    console.log(`Admitted execution ${receipt.launchId}`);
  },
};
export const { TubelessStudio, TubelessRun } = app.durableObjects;
