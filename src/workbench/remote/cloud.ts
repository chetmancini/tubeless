import { runAuth, openBrowser } from "../cloud/auth.js";
import { createCloudClient } from "../cloud/client.js";
import { resolveCloudHost } from "../cloud/config.js";
import { resolveCloudCredential } from "../cloud/credentials.js";
import { CloudClientError, isCloudAutomationToken } from "../cloud/protocol.js";
import type { CloudCommandDependencies } from "../cloud/shared.js";
import { chooseRemoteOption, type RemotePrompt } from "./prompt.js";
import type { RemoteProcessContext } from "./process.js";

export async function connectCloud(
  options: RemoteProcessContext & {
    host?: string;
    workspace?: string;
    create: boolean;
    ask: RemotePrompt;
    dependencies: CloudCommandDependencies;
  }
) {
  const { io, ask, dependencies } = options;
  const host = resolveCloudHost(options.host);
  const commandIo = { ...io, signal: options.signal, stdout: io.stderr };
  const environment = { env: options.env, store: dependencies.store, now: dependencies.now };
  const credential = () => resolveCloudCredential(host, environment);
  const login = async () => {
    if ((await runAuth(["login", "--host", host], commandIo, dependencies)) !== 0)
      throw new Error("Tubeless Cloud sign-in did not complete.");
    return credential();
  };
  const current = (await credential()) ?? (io.stdin?.isTTY ? await login() : undefined);
  if (!current) throw new Error("Run tubeless auth login or supply TUBELESS_TOKEN.");
  const cloudClient = (token: string) =>
    createCloudClient({ host, token, fetch: dependencies.fetch, signal: options.signal });
  let client = cloudClient(current.token);
  let workspaceId = options.workspace;
  let displayName = workspaceId;
  const dashboard = async (workspace?: string) => {
    const url = new URL("/app", host);
    if (workspace) url.searchParams.set("workspace", workspace);
    io.stderr.write(`Open ${url.href} to finish Cloud setup.\n`);
    if (io.stdin?.isTTY) await (dependencies.openBrowser ?? openBrowser)(url.href).catch(() => {});
  };
  if (!isCloudAutomationToken(current.token)) {
    const workspaces = async () => {
      try {
        return (await client.session()).workspaces;
      } catch (error) {
        if (
          !(error instanceof CloudClientError) ||
          error.status !== 401 ||
          current.source !== "stored" ||
          !io.stdin?.isTTY
        )
          throw error;
        const renewed = await login();
        if (!renewed) throw new Error("No active Cloud session.");
        client = cloudClient(renewed.token);
        return (await client.session()).workspaces;
      }
    };
    let available = await workspaces();
    if (options.create && workspaceId === undefined && io.stdin?.isTTY) {
      const choice = await chooseRemoteOption(
        [
          ...available.map((workspace) => ({ id: workspace.id, label: workspace.name })),
          { id: "", label: "Set up a new workspace in the browser" },
        ],
        "Tubeless Cloud workspace",
        ({ label }) => label,
        ask,
        io
      );
      if (choice.id) workspaceId = choice.id;
      else {
        await dashboard();
        await ask("Create or join a workspace in the dashboard, then press Enter: ");
        available = await workspaces();
      }
    }
    const workspace =
      workspaceId === undefined
        ? await chooseRemoteOption(
            available,
            "Tubeless Cloud workspaces",
            ({ name, id }) => `${name} (${id})`,
            ask,
            io
          )
        : available.find(({ id }) => id === workspaceId);
    if (!workspace) throw new Error("This Cloud session cannot access that workspace.");
    workspaceId = workspace.id;
    displayName = workspace.slug || workspace.name;
  }
  if (!workspaceId) throw new Error("Pass --workspace when connecting with an automation token.");
  const pipelines = await client.pipelines(workspaceId);
  if (options.create && !pipelines.some(({ available }) => available)) {
    await dashboard(workspaceId);
    await ask("Connect a GitHub repository and load a pipeline, then press Enter: ");
    if (!(await client.pipelines(workspaceId)).some(({ available }) => available))
      throw new Error(
        "No available pipelines yet. Finish setup in the dashboard, then rerun remote create."
      );
  }
  return {
    destination: { provider: "tubeless-cloud", host, workspaceId } as const,
    displayName: displayName ?? workspaceId,
    studio: `${host}/app?workspace=${encodeURIComponent(workspaceId)}`,
  };
}
