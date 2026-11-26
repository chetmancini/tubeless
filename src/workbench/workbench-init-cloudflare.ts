import { CLOUDFLARE_TARGET } from "./workbench-command-specs.js";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import type { DeployTargetScaffold } from "./workbench-init.js";

/**
 * Worker names must be at most 63 characters and R2 bucket names 3-63 characters that start and end
 * with a letter or number. The bucket appends "-artifacts" (10 characters), so the base stops at 53.
 */
export function defaultCloudflareWorkerName(cwd: string): string {
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

/** An import specifier names any IdentifierName, reserved words included, before `as`. */
const IDENTIFIER_NAME = /^[\p{ID_Start}$_][\p{ID_Continue}$\u200C\u200D]*$/u;

function projectImport(projectExport: string, specifier: string): string {
  const from = JSON.stringify(specifier);
  if (projectExport === "default") return `import project from ${from};`;
  if (!IDENTIFIER_NAME.test(projectExport)) {
    throw new Error(
      `The project export ${JSON.stringify(projectExport)} is not a JavaScript identifier; export the project as default or under an identifier name.`
    );
  }
  return projectExport === "project"
    ? `import { project } from ${from};`
    : `import { ${projectExport} as project } from ${from};`;
}

/**
 * Exact tooling versions the scaffold is verified against; a test keeps them
 * equal to this repository's devDependencies. `cf deploy` builds through
 * `@cloudflare/vite-plugin`, so all three are required and pinned together.
 */
export const CLOUDFLARE_DEV_DEPENDENCIES = {
  cf: "1.0.0-rc.6",
  vite: "8.3.8",
  "@cloudflare/vite-plugin": "2.0.0-rc.3",
} as const;

export const CLOUDFLARE_REMOTE_SETTINGS = "cloudflare/remote.json";
export const CLOUDFLARE_NODE_REQUIREMENT = "Node.js 22.23+, 24.22+, or 26.12+";

const cloudflareNodeMinimumMinor: Readonly<Record<string, number | undefined>> = {
  22: 23,
  24: 22,
  26: 12,
};

export function supportsCloudflareNode(version: string): boolean {
  const match = /^v?(\d+)\.(\d+)\.\d+$/.exec(version);
  if (!match) return false;
  const minimum = cloudflareNodeMinimumMinor[match[1]];
  return minimum !== undefined && Number(match[2]) >= minimum;
}

export interface CloudflareRemoteSettings {
  name: string;
  accountId: string;
  teamDomain: string;
  audience: string;
}

const devDependencyInstall = Object.entries(CLOUDFLARE_DEV_DEPENDENCIES)
  .map(([name, version]) => `${name}@${version}`)
  .join(" ");

const VITE_CONFIG = `import { defineConfig } from "vite";
import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig({ plugins: [cloudflare()] });
`;

type CloudflareIdentity = Pick<CloudflareRemoteSettings, "name" | "accountId">;

export function createCloudflareScaffold(remote?: CloudflareIdentity): DeployTargetScaffold {
  return {
    ...CLOUDFLARE_TARGET,
    loadsProject: true,
    files({ cwd, projectFile, projectExport }) {
      const name = remote?.name ?? defaultCloudflareWorkerName(cwd);
      const workerDirectory = join(cwd, "cloudflare");
      const importProject = projectImport(projectExport, importPath(workerDirectory, projectFile));
      return [
        {
          path: "cloudflare/worker.ts",
          contents: `import { env } from "cloudflare:workers";
import { createCloudflareApp } from "tubeless/cloudflare";
${importProject}

const { TUBELESS_VERSION } = env as { TUBELESS_VERSION: { id: string } };
const app = createCloudflareApp(project, { deploymentId: TUBELESS_VERSION.id });

export default app.worker;
export const { TubelessStudio, TubelessRun } = app.durableObjects;
`,
        },
        {
          path: "cloudflare.config.ts",
          contents: `import { bindings, defineConfig, defineWorker, exports as workerExports } from "cf/config";
import * as entrypoint from "./cloudflare/worker.ts" with { type: "cf-worker" };${remote ? `\nimport access from "./${CLOUDFLARE_REMOTE_SETTINGS}" with { type: "json" };` : ""}

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
    ${remote ? "accountId: access.accountId,\n    " : ""}worker: {
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
        TUBELESS_VERSION: bindings.versionMetadata(),
        // After enabling Cloudflare Access: "<team>.cloudflareaccess.com" and the application AUD tag.
        ACCESS_TEAM_DOMAIN: bindings.text(${remote ? "access.teamDomain" : '""'}),
        ACCESS_AUD: bindings.text(${remote ? "access.audience" : '""'}),
      },
    },
  };
});
`,
        },
        { path: "vite.config.ts", contents: VITE_CONFIG },
        ...(remote
          ? [
              {
                path: CLOUDFLARE_REMOTE_SETTINGS,
                contents:
                  JSON.stringify({ ...remote, teamDomain: "", audience: "" }, null, 2) + "\n",
              },
            ]
          : []),
      ];
    },
    // Vite loads exactly one of these names, so another config would shadow or be shadowed by ours.
    conflictsWith: [
      "vite.config.js",
      "vite.config.mjs",
      "vite.config.cjs",
      "vite.config.mts",
      "vite.config.cts",
    ].map((path) => ({
      path,
      hint: "Vite loads only one config file: rename it, run init again, then add cloudflare() from @cloudflare/vite-plugin to your config (see the Cloudflare guide).",
    })),
    nodeRequirement: {
      supports: supportsCloudflareNode,
      label: CLOUDFLARE_NODE_REQUIREMENT,
    },
    nextSteps: remote
      ? []
      : [
          `node --version   # cf requires ${CLOUDFLARE_NODE_REQUIREMENT}`,
          `bun add tubeless && bun add -d --exact ${devDependencyInstall}   # npm install -D -E … / pnpm add -D -E …`,
          "grep -qxF '.cloudflare/' .gitignore 2>/dev/null || printf '\\n.cloudflare/\\n' >> .gitignore   # cf build output and generated types",
          "npx cf auth login",
          "npx cf dev            # Studio on http://localhost:8787 (Access is skipped only on localhost)",
          "npx cf deploy         # creates the Worker, Durable Objects and R2 bucket",
          "Dashboard: Workers & Pages → your Worker → Settings → Domains & Routes → Enable Cloudflare Access",
          "Set ACCESS_TEAM_DOMAIN and ACCESS_AUD in cloudflare.config.ts, then run npx cf deploy again",
          "Guide: https://tubeless.io/docs/deploy-cloudflare",
        ],
  };
}

export const cloudflareScaffold = createCloudflareScaffold();
