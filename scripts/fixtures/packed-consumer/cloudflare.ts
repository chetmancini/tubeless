import { createSteps, definePipeline } from "tubeless";
import {
  createCloudflareApp,
  createR2CacheStore,
  jsonCacheCodec,
  type CloudflareApp,
  type CloudflareAppOptions,
  type CloudflareDurableObjectClass,
  type CloudflareWorker,
  type CloudflareLaunchOptions,
  type CloudflareLaunchResult,
  type CloudflareLaunchStatus,
  type CloudflareLaunchValues,
  type R2BucketLike,
  type R2ObjectLike,
  createCloudflareAgentTranscriptWriter,
} from "tubeless/cloudflare";
import { defineProject } from "tubeless/project";

// Type-checked only: the Cloudflare entry loads in workerd, not Node.
const objects = new Map<string, R2ObjectLike>();
const bucket: R2BucketLike = {
  async get(key) {
    return objects.get(key) ?? null;
  },
  async put(key, value, options) {
    const bytes = value.slice().buffer;
    objects.set(key, {
      arrayBuffer: async () => bytes,
      customMetadata: options?.customMetadata,
      uploaded: new Date(),
    });
  },
};
const { step } = createSteps();
const report = step("report", {
  cache: { version: "v1", store: createR2CacheStore(bucket), codec: jsonCacheCodec },
  run: () => ({ ok: true }),
});
const pipeline = definePipeline({ id: "report", steps: [report], finalize: report });
const options: CloudflareAppOptions = {
  deploymentId: "packed-v1",
  limits: { maxRunDurationMs: 600_000 },
};
const app: CloudflareApp = createCloudflareApp(
  defineProject("packed-cloudflare", [pipeline]),
  options
);
const worker: CloudflareWorker = app.worker;
const studio: CloudflareDurableObjectClass = app.durableObjects.TubelessStudio;
declare const studioRpc: InstanceType<typeof app.durableObjects.TubelessStudio>;
createCloudflareAgentTranscriptWriter(() => studioRpc);
export { studio as TubelessStudio, worker as default };
export const { TubelessRun } = app.durableObjects;

export async function launchFromCode(env: unknown): Promise<CloudflareLaunchStatus | undefined> {
  const values: CloudflareLaunchValues = {};
  const launchOptions: CloudflareLaunchOptions = { idempotencyKey: "packed.1" };
  const receipt: CloudflareLaunchResult = await app.launch(env, "report", values, launchOptions);
  if (receipt.accepted) return app.getLaunch(env, receipt.launchId);
  if (receipt.code === "idempotency_conflict") {
    const originalLaunchId: string = receipt.launchId;
    return app.getLaunch(env, originalLaunchId);
  }
  return undefined;
}
