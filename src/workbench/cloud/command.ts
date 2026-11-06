import { WORKBENCH_SPECS } from "../workbench-command-specs.js";
import {
  renderWorkbenchUsage,
  parseSubcommandArgs,
  runWorkbenchSubcommand,
} from "../workbench-subcommand.js";
import { createCloudClient, isCloudTransportError } from "./client.js";
import { resolveCloudHost } from "./config.js";
import { resolveCloudCredential } from "./credentials.js";
import { prepareRunInput, CloudRunUsageError } from "./run-input.js";
import { CloudClientError, isCloudAutomationToken, type CliRun } from "./protocol.js";

import {
  type WorkbenchCliIo,
  writeUsageError,
  writeCliChunk,
  terminalSafeText,
} from "../workbench-shared.js";
import {
  cloudErrorExit,
  cloudSignal,
  cloudSleep,
  type CloudCommandDependencies,
} from "./shared.js";

const CLOUD_USAGE = renderWorkbenchUsage(WORKBENCH_SPECS.cloud);
function runUrl(host: string, workspace: string, id: string): string {
  const url = new URL(`/app/runs/${encodeURIComponent(id)}`, host);
  url.searchParams.set("workspace", workspace);
  return url.href;
}
function terminal(run: CliRun): boolean {
  return ["completed", "failed", "cancelled"].includes(run.status);
}
function runExit(run: CliRun): number {
  return run.status === "completed" ? 0 : run.status === "cancelled" ? 7 : 6;
}

function admissionUncertain(error: unknown): boolean {
  if (!(error instanceof CloudClientError)) return true;
  if (error.status === undefined && error.code === "invalid_request") return false;
  return error.status === undefined || error.status < 400 || error.status >= 500;
}

async function followRun(
  initial: CliRun,
  getRun: () => Promise<CliRun>,
  output: WorkbenchCliIo["stdout"],
  signal: AbortSignal,
  dependencies: CloudCommandDependencies,
  human: boolean
): Promise<CliRun> {
  let current = initial;
  let printed = 0;
  let failures = 0;
  while (true) {
    if (human) {
      for (const log of current.logs.slice(printed))
        await writeCliChunk(
          output,
          `${new Date(log.time).toISOString()} ${log.level}: ${terminalSafeText(log.message)}\n`,
          signal
        );
      printed = Math.max(printed, current.logs.length);
    }
    if (terminal(current)) return current;
    await (dependencies.sleep ?? cloudSleep)(2000 * Math.max(failures, 1), signal);
    try {
      current = await getRun();
      failures = 0;
    } catch (error) {
      if (!isCloudTransportError(error) || ++failures >= 3) throw error;
    }
  }
}

export async function runCloud(
  argv: readonly string[],
  io: WorkbenchCliIo,
  dependencies: CloudCommandDependencies = {}
): Promise<number> {
  return runWorkbenchSubcommand(
    {
      spec: WORKBENCH_SPECS.cloud,
      parse: (args) => parseSubcommandArgs(args, WORKBENCH_SPECS.cloud.options),
      run: async ({ values, positionals }) => {
        const [command, selector] = positionals;
        if (!command || !WORKBENCH_SPECS.cloud.subcommands.some((name) => name === command))
          return writeUsageError(io, "Pass list, run, or logs.", CLOUD_USAGE);
        const wanted = command === "logs" || (command === "run" && !values.id) ? 2 : 1;
        if (positionals.length !== wanted)
          return writeUsageError(io, "Pass exactly the required command arguments.", CLOUD_USAGE);
        if (values.id && selector)
          return writeUsageError(io, "--id cannot be combined with a pipeline name.", CLOUD_USAGE);
        if (values.workspace !== undefined && !values.workspace.trim())
          return writeUsageError(io, "Pass a nonempty workspace ID.", CLOUD_USAGE);
        if (values.id !== undefined && !values.id.trim())
          return writeUsageError(io, "Pass a nonempty pipeline ID.", CLOUD_USAGE);
        const managed = cloudSignal(io);
        let admitted: { id: string; url: string } | undefined;
        try {
          const operation =
            command === "run"
              ? {
                  kind: "run" as const,
                  ...(await prepareRunInput(values, {
                    cwd: io.cwd,
                    signal: managed.signal,
                    readStdin: dependencies.readStdin,
                  })),
                }
              : command === "list"
                ? { kind: "list" as const }
                : { kind: "logs" as const };
          const host = resolveCloudHost(values.host);
          const credential = await resolveCloudCredential(host, {
            store: dependencies.store,
            env: dependencies.env,
            now: dependencies.now,
          });
          if (!credential)
            throw new Error(
              "No active Cloud credential. Run tubeless auth login or supply TUBELESS_TOKEN."
            );
          const client = createCloudClient({
            host,
            token: credential.token,
            fetch: dependencies.fetch,
            signal: managed.signal,
          });
          let workspace = values.workspace;
          if (!workspace) {
            if (isCloudAutomationToken(credential.token))
              throw new Error(
                "Automation credentials require --workspace <id>; session workspace discovery is unavailable."
              );
            const session = await client.session();
            if (session.workspaces.length === 0)
              throw new Error(
                "No Cloud workspaces are available. Create or join a workspace in the Cloud dashboard, then try again."
              );
            if (session.workspaces.length !== 1)
              throw new Error(
                `Choose a workspace with --workspace <id>:\n${session.workspaces.map((item) => `${item.name} (${item.id})`).join("\n")}`
              );
            workspace = session.workspaces[0]!.id;
          }
          if (operation.kind === "list") {
            const pipelines = await client.pipelines(workspace);
            if (values.json) io.stdout.write(`${JSON.stringify(pipelines)}\n`);
            else
              for (const pipeline of pipelines)
                io.stdout.write(
                  `${terminalSafeText(pipeline.slug)}: ${terminalSafeText(pipeline.name)} (${terminalSafeText(pipeline.id)}) ${pipeline.available ? "available" : "unavailable"} commit=${terminalSafeText(pipeline.commit)} branch=${terminalSafeText(pipeline.branch)}\n`
                );
            return 0;
          }
          if (operation.kind === "logs") {
            let run = await client.getRun(workspace, selector!);
            admitted = { id: run.id, url: runUrl(host, workspace, run.id) };
            if (values.follow)
              run = await followRun(
                run,
                () => client.getRun(workspace, run.id),
                io.stdout,
                managed.signal,
                dependencies,
                !values.json
              );
            else if (!values.json)
              for (const log of run.logs)
                await writeCliChunk(
                  io.stdout,
                  `${new Date(log.time).toISOString()} ${log.level}: ${terminalSafeText(log.message)}\n`,
                  managed.signal
                );
            if (values.json)
              io.stdout.write(
                `${JSON.stringify({ id: run.id, pipelineId: run.pipelineId, status: run.status, logs: run.logs })}\n`
              );
            else
              io.stdout.write(
                `Run ${terminalSafeText(run.id)}: ${run.status}\n${terminalSafeText(admitted.url)}\n`
              );
            return values.follow ? runExit(run) : 0;
          }
          let pipelineId = values.id;
          if (pipelineId === undefined) {
            const pipelines = await client.pipelines(workspace);
            const matches = pipelines.filter(
              (item) => item.name === selector || item.slug === selector
            );
            if (matches.length === 0)
              throw new Error(
                "Cloud pipeline not found in this workspace. Use tubeless cloud list or the Cloud dashboard to select a loaded pipeline."
              );
            if (matches.length !== 1)
              throw new Error(
                `Multiple pipelines match ${JSON.stringify(selector)}. Choose --id <id>:\n${matches.map((item) => `${item.slug}: ${item.name} (${item.id})`).join("\n")}`
              );
            pipelineId = matches[0]!.id;
          }
          const { input, source, idempotencyKey: key } = operation;
          if (managed.signal.aborted) throw new Error("Run admission interrupted.");
          const request = { pipelineId, input, ...(source ? { source } : {}) };
          let run: CliRun;
          try {
            try {
              run = await client.run(workspace, request, key);
            } catch (error) {
              if (!isCloudTransportError(error) || managed.signal.aborted) throw error;
              run = await client.run(workspace, request, key);
            }
          } catch (error) {
            // Local validation and explicit 4xx responses establish rejection.
            // A 5xx, unusable response or interrupted POST can follow admission.
            if (admissionUncertain(error)) {
              io.stderr.write(
                `Admission could not be confirmed. Workspace: ${terminalSafeText(workspace)}; idempotency key: ${key}. Host: ${host}; pipeline ID: ${terminalSafeText(pipelineId)}. Retry with --idempotency-key ${key}, the same --id, --host and --workspace, and identical input and source selection (--ref or --source) under the same principal. Do not start a fresh run.\n`
              );
            }
            throw error;
          }
          admitted = { id: run.id, url: runUrl(host, workspace, run.id) };
          const progress = values.json ? io.stderr : io.stdout;
          progress.write(
            `Run ${terminalSafeText(run.id)}: ${terminalSafeText(run.pipelineName)}\nWorkspace: ${terminalSafeText(workspace)}\nSource commit: ${terminalSafeText(run.commit)}\n${terminalSafeText(admitted.url)}\nLocal changes are not used.\n${source ? `Requested source: ${terminalSafeText(JSON.stringify(source))}\n` : ""}`
          );
          if (values.detach) {
            if (values.json) io.stdout.write(`${JSON.stringify(run)}\n`);
            return 0;
          }
          run = await followRun(
            run,
            () => client.getRun(workspace, run.id),
            io.stdout,
            managed.signal,
            dependencies,
            !values.json
          );
          if (values.json) io.stdout.write(`${JSON.stringify(run)}\n`);
          else {
            io.stdout.write(`Run ${terminalSafeText(run.id)}: ${run.status}\n`);
            if (run.result !== undefined)
              io.stdout.write(`${terminalSafeText(JSON.stringify(run.result))}\n`);
            if (run.error) io.stderr.write(`${terminalSafeText(run.error)}\n`);
          }
          return runExit(run);
        } catch (error) {
          if (error instanceof CloudRunUsageError)
            return writeUsageError(io, error.message, CLOUD_USAGE);
          if (admitted)
            io.stderr.write(
              `Run ${terminalSafeText(admitted.id)}\n${terminalSafeText(admitted.url)}\n`
            );
          if (
            admitted &&
            command === "run" &&
            error instanceof CloudClientError &&
            error.code === "forbidden"
          )
            io.stderr.write(
              "The run was admitted. Following requires read scope; use --detach for run-only credentials.\n"
            );
          return cloudErrorExit(error, io, managed.signal);
        } finally {
          managed.cleanup();
        }
      },
    },
    argv,
    io
  );
}
