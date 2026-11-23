import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isJsonObject } from "../../utilities/canonical-json.js";
import {
  CLOUDFLARE_DEV_DEPENDENCIES,
  CLOUDFLARE_REMOTE_SETTINGS,
  CLOUDFLARE_MINIMUM_NODE,
  createCloudflareScaffold,
  defaultCloudflareWorkerName,
  type CloudflareRemoteSettings,
} from "../workbench-init-cloudflare.js";
import { initDeployment, initProject, scaffoldPathOccupied } from "../workbench-init.js";
import { DEFAULT_PIPELINE_PROJECT_FILE } from "../workbench-project-loader.js";
import {
  cfCommands,
  connectCloudflare,
  workerOrigin,
  tubelessWorkerNames,
  type CloudflareRemoteContext,
} from "./cloudflare.js";
import { remoteNames } from "./profiles.js";
import { remoteProcess } from "./process.js";
import { versionAtLeast } from "../workbench-runtime.js";

async function readSettings(file: string): Promise<CloudflareRemoteSettings | undefined> {
  const contents = await readFile(file, "utf8").catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  if (contents === undefined) return undefined;
  const value: unknown = JSON.parse(contents);
  if (isJsonObject(value)) {
    const { name, accountId, teamDomain, audience } = value;
    if (
      typeof name === "string" &&
      typeof accountId === "string" &&
      typeof teamDomain === "string" &&
      typeof audience === "string"
    )
      return { name, accountId, teamDomain, audience };
  }
  throw new Error("The generated Cloudflare remote settings file is invalid.");
}

async function writeSettings(path: string, settings: CloudflareRemoteSettings): Promise<void> {
  const temp = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temp, JSON.stringify(settings, null, 2) + "\n", { flag: "wx" });
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

async function installToolchain(options: CloudflareRemoteContext) {
  const run = remoteProcess(options);
  const read = await readFile(join(options.io.cwd, "package.json"), "utf8").catch(
    (error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "{}";
      throw error;
    }
  );
  const packageJson: unknown = JSON.parse(read);
  if (!isJsonObject(packageJson)) throw new Error("package.json must be a JSON object.");
  const deps = isJsonObject(packageJson.dependencies) ? packageJson.dependencies : {};
  const dev = isJsonObject(packageJson.devDependencies) ? packageJson.devDependencies : {};
  if (packageJson.name !== "tubeless" && !deps.tubeless && !dev.tubeless)
    await run("bun", ["add", "tubeless"], { interactive: true });
  const missing = Object.entries(CLOUDFLARE_DEV_DEPENDENCIES)
    .filter(([name, version]) => dev[name] !== version)
    .map(([name, version]) => `${name}@${version}`);
  if (missing.length)
    await run("bun", ["add", "--dev", "--exact", ...missing], { interactive: true });
  else if (!(await scaffoldPathOccupied(join(options.io.cwd, "node_modules", ".bin", "cf"))))
    await run("bun", ["install", "--frozen-lockfile"], { interactive: true });
}

function workerAccess(cf: ReturnType<typeof cfCommands>, accountId: string, name: string) {
  const appName = `Tubeless ${name}`;
  const applications = ["zero-trust", "access", "applications"];
  function audienceOf(app: unknown): string {
    if (!isJsonObject(app) || typeof app.aud !== "string" || !app.aud)
      throw new Error("Cloudflare did not return an Access audience.");
    return app.aud;
  }
  return {
    async find(id: string): Promise<string | undefined> {
      const matches = (
        await cf.list([...applications, "list", "--name", appName], accountId)
      ).filter((item) => item.name === appName);
      const [app] = matches;
      if (!app) return undefined;
      if (
        matches.length !== 1 ||
        !Array.isArray(app.destinations) ||
        !app.destinations.some(
          (entry: unknown) =>
            isJsonObject(entry) && entry.type === "worker" && entry.worker_id === id
        )
      )
        throw new Error(
          `Access application "${appName}" is ambiguous or points to another Worker.`
        );
      return audienceOf(app);
    },
    async create(id: string, email: string): Promise<string> {
      const application = {
        type: "self_hosted",
        name: appName,
        destinations: [{ type: "worker", worker_id: id }],
        policies: [{ name: "Studio access", decision: "allow", include: [{ email: { email } }] }],
      };
      return audienceOf(
        await cf.json([...applications, "create", "--body", JSON.stringify(application)], accountId)
      );
    },
  };
}

export async function createCloudflareRemote(
  options: CloudflareRemoteContext & {
    directory: string;
    name?: string;
    project?: string;
    email?: string;
    yes?: boolean;
  }
) {
  const { io, ask } = options;
  const path = join(io.cwd, CLOUDFLARE_REMOTE_SETTINGS);
  const saved = await readSettings(path);
  const inferred = defaultCloudflareWorkerName(io.cwd);
  const name =
    options.name ??
    saved?.name ??
    ((await ask(`Worker and remote name [${inferred}]: `)) || inferred);
  if (!/^[a-z0-9](?:[a-z0-9-]{0,51}[a-z0-9])?$/.test(name))
    throw new Error("Use a Worker name of up to 53 lowercase letters, digits or hyphens.");
  if ((await remoteNames(options.directory)).includes(name))
    throw new Error(
      `Remote "${name}" already exists. Choose another --name or use the saved remote.`
    );
  if (saved && (name !== saved.name || (options.account && options.account !== saved.accountId)))
    throw new Error(
      "The existing Cloudflare scaffold is linked to another Worker or account. Run remote connect for the other destination."
    );
  const configFile = "cloudflare.config.ts";
  const unmanaged = ["wrangler.jsonc", "wrangler.json", "wrangler.toml"];
  if (!saved) unmanaged.unshift(configFile);
  const present = await Promise.all(
    unmanaged.map((file) => scaffoldPathOccupied(join(io.cwd, file)))
  );
  const conflict = unmanaged.find((_, index) => present[index]);
  if (conflict)
    throw new Error(
      `Existing ${conflict} found. Deploy it normally and use remote connect to attach it.`
    );
  if (saved && !(await scaffoldPathOccupied(join(io.cwd, configFile))))
    throw new Error("Restore cloudflare.config.ts for this managed project before resuming setup.");

  const run = remoteProcess(options);
  const node = (await run("node", ["--version"]).catch(() => "")).trim();
  if (!/^v\d+\.\d+\.\d+/.test(node) || !versionAtLeast(node, CLOUDFLARE_MINIMUM_NODE))
    throw new Error(`Cloudflare deployment needs Node.js ${CLOUDFLARE_MINIMUM_NODE} or newer.`);
  try {
    await run("cloudflared", ["--version"]);
  } catch {
    throw new Error("Install cloudflared to sign in to the new Studio, then rerun remote create.");
  }

  const cf = cfCommands(options);
  const accountId = await cf.account(saved?.accountId);
  const getWorker = async () => {
    const worker = (await cf.list(["workers", "list"], accountId)).find(
      (item) => item.name === name
    );
    if (!worker) return undefined;
    if (typeof worker.id !== "string" || !worker.id)
      throw new Error("Cloudflare returned a Worker without an ID.");
    return { ...worker, id: worker.id };
  };
  const [team, existing] = await Promise.all([
    cf.json(["zero-trust", "organization", "get"], accountId),
    getWorker(),
  ]);
  if (
    !isJsonObject(team) ||
    typeof team.auth_domain !== "string" ||
    !/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(team.auth_domain)
  )
    throw new Error("Enable Cloudflare Zero Trust for this account, then rerun remote create.");
  const teamDomain = team.auth_domain;
  if (existing && !saved)
    throw new Error(
      "A Worker with that name already exists in this account. Use remote connect or choose another name."
    );
  if (existing && !(await tubelessWorkerNames(cf, accountId)).has(name))
    throw new Error(
      "The existing Worker lacks the Tubeless Durable Object classes. Refusing to redeploy it."
    );
  const access = workerAccess(cf, accountId, name);
  const audience = existing && (await access.find(existing.id));
  const accessPlan = audience
    ? { audience }
    : { email: options.email ?? (await ask("Email allowed to sign in to Studio: ")) };
  if (accessPlan.email !== undefined && !/^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(accessPlan.email))
    throw new Error("Pass one valid Access email address.");
  if (
    !options.yes &&
    !/^y(?:es)?$/i.test(
      await ask(`Deploy "${name}" and configure Cloudflare Access in account ${accountId}? [y/N] `)
    )
  )
    throw new Error("Remote creation cancelled.");
  const scaffoldIo = { ...io, stdout: io.stderr };
  if (
    !saved &&
    !options.project &&
    !(await scaffoldPathOccupied(join(io.cwd, DEFAULT_PIPELINE_PROJECT_FILE))) &&
    (await initProject(scaffoldIo)) !== 0
  )
    throw new Error("Could not initialize a Tubeless project.");
  await installToolchain(options);
  if (
    !saved &&
    (await initDeployment(
      createCloudflareScaffold({ name, accountId }),
      options.project,
      scaffoldIo
    )) !== 0
  )
    throw new Error("Could not scaffold the Cloudflare remote.");
  if (!existing) await cf.deploy(accountId);
  const worker = existing ?? (await getWorker());
  if (!worker)
    throw new Error(
      "Cloudflare did not return the deployed Worker. Rerun remote create to resume."
    );
  const host = workerOrigin(worker);
  const verifiedAudience =
    accessPlan.email === undefined
      ? accessPlan.audience
      : (!existing && (await access.find(worker.id))) ||
        (await access.create(worker.id, accessPlan.email));
  if (saved?.audience !== verifiedAudience || saved.teamDomain !== teamDomain)
    await writeSettings(path, { name, accountId, teamDomain, audience: verifiedAudience });
  await cf.deploy(accountId);
  return { ...(await connectCloudflare(host, options, "user")), displayName: name };
}
