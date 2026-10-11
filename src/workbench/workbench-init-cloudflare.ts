import { basename, isAbsolute, join, relative, sep } from "node:path";
import type { DeployTargetScaffold } from "./workbench-init.js";

/**
 * Worker names must be at most 63 characters and R2 bucket names 3-63 characters that start and end
 * with a letter or number. The bucket appends "-artifacts" (10 characters), so the base stops at 53.
 */
function workerName(cwd: string): string {
  const base = basename(cwd)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 53)
    .replace(/^-+|-+$/g, "");
  return base || "tubeless";
}

function importPath(fromDirectory: string, file: string): string {
  const path = relative(fromDirectory, file);
  if (isAbsolute(path)) {
    throw new Error(`Cannot import ${file} from ${fromDirectory}: they are on different drives.`);
  }
  const specifier = path.split(sep).join("/");
  return specifier.startsWith("./") || specifier.startsWith("../") ? specifier : `./${specifier}`;
}

export const cloudflareScaffold: DeployTargetScaffold = {
  id: "cloudflare",
  description: "Worker, Durable Objects and R2 with Studio behind Cloudflare Access",
  files({ cwd, projectFile }) {
    const name = workerName(cwd);
    const workerDirectory = join(cwd, "cloudflare");
    // Interpolated so the runtime graph checks do not mistake template text for an import of this module.
    const workerImport = importPath(cwd, join(workerDirectory, "worker.ts"));
    return [
      {
        path: "cloudflare/worker.ts",
        contents: `import { createCloudflareApp } from "tubeless/cloudflare";
import project from ${JSON.stringify(importPath(workerDirectory, projectFile))};

const app = createCloudflareApp(project);

export default app.worker;
export const { TubelessStudio, TubelessRun } = app.durableObjects;
`,
      },
      {
        path: "cloudflare.config.ts",
        contents: `import { bindings, defineConfig, defineWorker, exports as workerExports } from "cf/config";
import * as entrypoint from "${workerImport}" with { type: "cf-worker" };

export default defineConfig(() => {
  const worker = defineWorker({
    name: "${name}",
    entrypoint,
    compatibilityDate: "2026-10-01",
    compatibilityFlags: ["nodejs_compat"],
    // Workers Paid: allow up to 5 minutes of CPU per run (runs are capped at 14 minutes of wall time).
    // limits: { cpuMs: 300_000 },
    exports: {
      TubelessStudio: workerExports.durableObject({ storage: "sqlite" }),
      TubelessRun: workerExports.durableObject({ storage: "sqlite" }),
    },
  });
  return {
    worker: {
      ...worker,
      workersDev: true,
      observability: { enabled: true, logs: { enabled: true } },
      env: {
        TUBELESS_STUDIO: bindings.durableObject<typeof worker, "TubelessStudio">({
          worker,
          exportName: "TubelessStudio",
        }),
        TUBELESS_RUN: bindings.durableObject<typeof worker, "TubelessRun">({
          worker,
          exportName: "TubelessRun",
        }),
        TUBELESS_BUCKET: bindings.r2({ name: "${name}-artifacts" }),
        // After enabling Cloudflare Access: "<team>.cloudflareaccess.com" and the application AUD tag.
        ACCESS_TEAM_DOMAIN: bindings.text(""),
        ACCESS_AUD: bindings.text(""),
      },
    },
  };
});
`,
      },
    ];
  },
  nextSteps: [
    "bun add tubeless && bun add -d cf@1.0.0-beta.13   # or npm/pnpm equivalents",
    "npx cf auth login",
    "npx cf dev            # Studio on http://localhost:8787 (Access is skipped only on localhost)",
    "npx cf deploy         # creates the Worker, Durable Objects and R2 bucket",
    "Dashboard: Workers & Pages → your Worker → Settings → Domains & Routes → Enable Cloudflare Access",
    "Set ACCESS_TEAM_DOMAIN and ACCESS_AUD in cloudflare.config.ts, then run npx cf deploy again",
    "Guide: https://tubeless.io/docs/deploy-cloudflare",
  ],
};
