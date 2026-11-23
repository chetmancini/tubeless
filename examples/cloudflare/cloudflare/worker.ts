import { env } from "cloudflare:workers";
import { createCloudflareApp } from "tubeless/cloudflare";
import project from "../tubeless.project.ts";

const { TUBELESS_VERSION } = env as { TUBELESS_VERSION: { id: string } };
const app = createCloudflareApp(project, { deploymentId: TUBELESS_VERSION.id });

export default app.worker;
export const { TubelessStudio, TubelessRun } = app.durableObjects;
