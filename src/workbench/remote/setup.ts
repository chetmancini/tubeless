import { normalizeRemoteOrigin } from "../workbench-remote-io.js";
import { resolveCloudHost } from "../cloud/config.js";
import type { CloudCommandDependencies } from "../cloud/shared.js";
import { connectCloud } from "./cloud.js";
import { connectCloudflare, discoverCloudflare } from "./cloudflare.js";
import { createCloudflareRemote } from "./create-cloudflare.js";
import { chooseRemoteOption, remotePrompt } from "./prompt.js";
import { defaultRemoteName, readRemote, remoteName, remoteNames, saveRemote } from "./profiles.js";
import type { RemoteProcessContext } from "./process.js";

const PROVIDERS = [
  { id: "tubeless-cloud", label: "Tubeless Cloud" },
  { id: "cloudflare", label: "Cloudflare (self-hosted)" },
] as const;

export async function setupRemote(
  operation: "connect" | "create" | "list",
  target: string | undefined,
  options: {
    host?: string;
    provider?: string;
    name?: string;
    account?: string;
    workspace?: string;
    project?: string;
    email?: string;
    json?: boolean;
    yes?: boolean;
  },
  context: RemoteProcessContext & { directory: string; dependencies: CloudCommandDependencies }
): Promise<number> {
  const { io, directory } = context;
  if (operation === "list") {
    const names = await remoteNames(directory);
    const remotes = await Promise.all(
      names.map(async (name) => ({ name, ...(await readRemote(directory, name)) }))
    );
    if (options.json) io.stdout.write(JSON.stringify(remotes) + "\n");
    else {
      for (const { name, provider, host } of remotes)
        io.stdout.write(`${name}  ${provider}  ${host}\n`);
      if (remotes.length === 0)
        io.stdout.write("No remotes configured. Run tubeless remote connect or remote create.\n");
    }
    return 0;
  }
  if (target !== undefined && options.host !== undefined)
    throw new Error("Pass a URL or --host, not both.");
  const hostInput = target ?? options.host;
  const host =
    hostInput === undefined ? undefined : normalizeRemoteOrigin(hostInput, "Remote host");
  const selected = PROVIDERS.find(({ id }) => id === options.provider);
  if (options.provider !== undefined && !selected)
    throw new Error("Choose --provider cloudflare or --provider tubeless-cloud.");
  if (options.name !== undefined) remoteName(options.name);
  const ask = remotePrompt(io, context.signal);
  const provider =
    selected?.id ??
    (options.workspace || host === resolveCloudHost()
      ? "tubeless-cloud"
      : options.account || host
        ? "cloudflare"
        : (await chooseRemoteOption(PROVIDERS, "hosting provider", ({ label }) => label, ask, io))
            .id);
  if (provider === "cloudflare" && options.workspace)
    throw new Error("--workspace is only for Tubeless Cloud.");
  if (provider === "tubeless-cloud" && (options.account || options.project || options.email))
    throw new Error("--account, --project and --email are only for Cloudflare.");
  if (provider === "cloudflare" && operation === "create" && host)
    throw new Error("Use remote connect to attach an existing Cloudflare URL.");
  const cf = { ...context, account: options.account, fetch: context.dependencies.fetch, ask };
  const remote =
    provider === "tubeless-cloud"
      ? await connectCloud({
          ...context,
          host,
          workspace: options.workspace,
          create: operation === "create",
          ask,
        })
      : operation === "create"
        ? await createCloudflareRemote({
            ...cf,
            name: options.name,
            project: options.project,
            email: options.email,
            yes: options.yes,
          })
        : await connectCloudflare(host ?? (await discoverCloudflare(cf)), cf);

  const suggested = defaultRemoteName(remote.displayName);
  let name = options.name ?? suggested;
  if (!options.name && io.stdin?.isTTY && !(operation === "create" && provider === "cloudflare"))
    name = (await ask(`Remote name [${suggested}]: `)) || suggested;
  await saveRemote(directory, name, remote.destination);
  if (options.json)
    io.stdout.write(JSON.stringify({ name, ...remote.destination, studio: remote.studio }) + "\n");
  else io.stdout.write(`Connected "${name}" to ${remote.destination.host}.\n${remote.studio}\n`);
  return 0;
}
