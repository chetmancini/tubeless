import { isJsonObject } from "../../utilities/canonical-json.js";
import { readBoundedBody } from "../../utilities/read-body.js";
import { HOSTED_EXECUTIONS_PATH } from "../../hosting/execution-status.js";
import { isLaunchIdentifier } from "../../utilities/launch-identifier.js";
import { normalizeRemoteOrigin } from "../workbench-remote-io.js";
import { CLOUDFLARE_DEV_DEPENDENCIES } from "../workbench-init-cloudflare.js";
import { chooseRemoteOption, type RemotePrompt } from "./prompt.js";
import { workerHeaders } from "./access.js";
import { remoteProcess, type RemoteProcessContext } from "./process.js";

export type CloudflareRemoteContext = RemoteProcessContext & {
  ask: RemotePrompt;
  fetch?: typeof fetch;
  account?: string;
};

async function workerDiscovery(host: string, headers: Headers, options: CloudflareRemoteContext) {
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(15_000)]);
  const response = await (options.fetch ?? fetch)(host + HOSTED_EXECUTIONS_PATH, {
    headers,
    signal,
    redirect: "manual",
    credentials: "omit",
  });
  const { status } = response;
  if (response.headers.get("content-type")?.includes("application/json")) {
    const bytes = await readBoundedBody(response.body, 65_536, signal);
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (isJsonObject(value)) {
      if (
        status === 200 &&
        typeof value.projectId === "string" &&
        isLaunchIdentifier(value.deploymentId)
      )
        return value.projectId;
      // Older execution APIs return this error for GET on the collection.
      if (status === 404 && value.code === "execution_not_found") return undefined;
    }
  } else await response.body?.cancel();
  throw new Error(
    `Could not verify the Tubeless execution API at ${host} (HTTP ${status}). Check Access and the deployment configuration.`
  );
}

export function cfCommands(context: CloudflareRemoteContext) {
  const execute = remoteProcess(context);
  const cf = (args: readonly string[], accountId?: string, interactive = false) =>
    execute("npx", ["--yes", `cf@${CLOUDFLARE_DEV_DEPENDENCIES.cf}`, ...args], {
      env: accountId === undefined ? undefined : { CLOUDFLARE_ACCOUNT_ID: accountId },
      interactive,
    });
  const json = async (args: readonly string[], accountId?: string): Promise<unknown> =>
    JSON.parse(await cf(["--quiet", ...args], accountId)) as unknown;
  const list = async (args: readonly string[], accountId?: string) => {
    const result: Record<string, unknown>[] = [];
    const perPage = 25;
    for (let page = 1; ; page++) {
      const rows = await json(
        [...args, "--page", String(page), "--per-page", String(perPage)],
        accountId
      );
      if (!Array.isArray(rows) || !rows.every(isJsonObject))
        throw new Error("Cloudflare returned an invalid list.");
      result.push(...rows);
      if (rows.length < perPage) return result;
    }
  };
  const account = async (explicit?: string) => {
    if (!context.env.CLOUDFLARE_API_TOKEN) {
      const identity = await json(["auth", "whoami", "--json"]).catch(() => undefined);
      if (!isJsonObject(identity) || identity.authenticated !== true) {
        if (!context.io.stdin?.isTTY)
          throw new Error(
            "Run cf auth login or set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID."
          );
        await cf(["auth", "login"], undefined, true);
      }
    }
    const selected = explicit ?? context.account ?? context.env.CLOUDFLARE_ACCOUNT_ID;
    if (selected) return selected;
    const accounts = (await list(["accounts", "list"])).flatMap((item) =>
      typeof item.id === "string" && typeof item.name === "string"
        ? [{ id: item.id, name: item.name }]
        : []
    );
    return (
      await chooseRemoteOption(
        accounts,
        "Cloudflare accounts",
        ({ name }) => name,
        context.ask,
        context.io
      )
    ).id;
  };
  const deploy = (accountId: string) =>
    execute("npx", ["--no-install", "cf", "deploy"], {
      env: { CLOUDFLARE_ACCOUNT_ID: accountId },
      interactive: true,
    });
  return { json, list, account, deploy };
}

function workerOrigins(worker: Record<string, unknown>): string[] {
  const references = isJsonObject(worker.references) ? worker.references : {};
  const domains = Array.isArray(references.domains) ? references.domains : [];
  const custom = domains.flatMap((domain) =>
    isJsonObject(domain) && typeof domain.hostname === "string"
      ? [`https://${domain.hostname}`]
      : []
  );
  const subdomain = worker.subdomain;
  const enabled =
    isJsonObject(subdomain) && subdomain.enabled === true && typeof subdomain.url === "string"
      ? [subdomain.url]
      : [];
  return [...custom, ...enabled].flatMap((value) => {
    try {
      return [normalizeRemoteOrigin(value, "Worker host")];
    } catch {
      return [];
    }
  });
}

export async function tubelessWorkerNames(
  cf: ReturnType<typeof cfCommands>,
  accountId: string
): Promise<Set<string>> {
  const namespaces = await cf.list(["durable-objects", "namespaces", "list"], accountId);
  const run = new Set(
    namespaces.flatMap((item) =>
      item.class === "TubelessRun" && typeof item.script === "string" ? [item.script] : []
    )
  );
  return new Set(
    namespaces.flatMap((item) =>
      item.class === "TubelessStudio" && typeof item.script === "string" && run.has(item.script)
        ? [item.script]
        : []
    )
  );
}

export function workerOrigin(worker: Record<string, unknown>): string {
  const host = workerOrigins(worker)[0];
  if (!host)
    throw new Error(
      "This Worker has no enabled hostname. Enable workers.dev or attach a custom domain."
    );
  return host;
}

export async function discoverCloudflare(options: CloudflareRemoteContext): Promise<string> {
  const cf = cfCommands(options);
  const accountId = await cf.account();
  const [deployed, projects] = await Promise.all([
    cf.list(["workers", "list"], accountId),
    tubelessWorkerNames(cf, accountId),
  ]);
  const origins = new Map<string, string>();
  for (const worker of deployed) {
    if (typeof worker.name !== "string" || !projects.has(worker.name)) continue;
    for (const origin of workerOrigins(worker)) origins.set(origin, worker.name);
  }
  if (origins.size === 0)
    throw new Error("No Tubeless Workers found. Re-run remote connect with the Studio URL.");
  return (
    await chooseRemoteOption(
      [...origins],
      "Tubeless Workers",
      ([origin, name]) => `${name} (${origin})`,
      options.ask,
      options.io
    )
  )[0];
}

export async function connectCloudflare(
  host: string,
  options: CloudflareRemoteContext,
  access = options.env.CF_ACCESS_CLIENT_ID && options.env.CF_ACCESS_CLIENT_SECRET
    ? ("service" as const)
    : ("user" as const)
) {
  const headers = await workerHeaders(host, options, access);
  const projectId = await workerDiscovery(host, headers, options);
  return {
    destination: { provider: "cloudflare", host, access, projectId } as const,
    displayName: projectId ?? new URL(host).hostname.split(".")[0],
    studio: host,
  };
}
