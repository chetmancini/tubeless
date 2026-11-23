import { manageRemoteSignal } from "../workbench-remote-io.js";
import { WORKBENCH_SPECS } from "../workbench-command-specs.js";
import {
  renderWorkbenchUsage,
  parseSubcommandArgs,
  runWorkbenchSubcommand,
} from "../workbench-subcommand.js";
import { createCloudClient, isCloudTransportError } from "./client.js";
import { resolveCloudHost } from "./config.js";
import { resolveCloudCredential } from "./credentials.js";
import { isFollowCursor } from "./follow-protocol.js";
import { pollCloudRun, streamCloudRun, writeCloudLog } from "./follow.js";
import { prepareRunInput, CloudRunUsageError } from "./run-input.js";
import {
  CloudClientError,
  isCloudAutomationToken,
  type CliRun,
  type CliSession,
} from "./protocol.js";

import {
  type WorkbenchCliIo,
  writeUsageError,
  errorMessage,
  terminalSafeText,
} from "../workbench-shared.js";
import { cloudErrorExit, cloudSleep, type CloudCommandDependencies } from "./shared.js";

const CLOUD_USAGE = renderWorkbenchUsage(WORKBENCH_SPECS.cloud);
function runUrl(host: string, workspace: string, id: string): string {
  const url = new URL(`/app/runs/${encodeURIComponent(id)}`, host);
  url.searchParams.set("workspace", workspace);
  return url.href;
}
function runExit(run: CliRun): number {
  return run.status === "completed" ? 0 : run.status === "cancelled" ? 7 : 6;
}

function admissionUncertain(error: unknown): boolean {
  if (!(error instanceof CloudClientError)) return true;
  if (error.status === undefined && error.code === "invalid_request") return false;
  return error.status === undefined || error.status < 400 || error.status >= 500;
}

interface RunRecovery {
  host: string;
  workspaceId: string;
  runId: string;
  cursor?: string;
}

function observationError(error: unknown, signal: AbortSignal): CloudClientError {
  if (signal.aborted)
    return new CloudClientError(
      "Stopped following Cloud activity. Remote work continues.",
      "observation_interrupted"
    );
  if (error instanceof CloudClientError) {
    if (error.code === "timeout")
      return new CloudClientError("Cloud observation timed out.", "observation_timeout");
    return error;
  }
  return new CloudClientError(errorMessage(error), "observation_error");
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
          return writeUsageError(io, "Pass list, run, follow, or logs.", CLOUD_USAGE);
        const wanted =
          command === "logs" || command === "follow" || (command === "run" && !values.id) ? 2 : 1;
        if (positionals.length !== wanted)
          return writeUsageError(io, "Pass exactly the required command arguments.", CLOUD_USAGE);
        if (values.id && selector)
          return writeUsageError(io, "--id cannot be combined with a pipeline name.", CLOUD_USAGE);
        if (values.workspace !== undefined && !values.workspace.trim())
          return writeUsageError(io, "Pass a nonempty workspace ID.", CLOUD_USAGE);
        if (values.id !== undefined && !values.id.trim())
          return writeUsageError(io, "Pass a nonempty pipeline ID.", CLOUD_USAGE);
        if ((command === "logs" || command === "follow") && !selector.trim())
          return writeUsageError(io, "Pass a nonempty run ID.", CLOUD_USAGE);
        if ((values.poll || values.cursor !== undefined) && command === "logs" && !values.follow)
          return writeUsageError(
            io,
            "Pass --follow to observe an existing run with cloud logs.",
            CLOUD_USAGE
          );
        if (values.poll && (values.detach || values.cursor !== undefined))
          return writeUsageError(
            io,
            "--poll cannot be combined with --detach or --cursor.",
            CLOUD_USAGE
          );
        if (values.cursor !== undefined && !isFollowCursor(values.cursor))
          return writeUsageError(io, "Pass a valid nonempty run-following cursor.", CLOUD_USAGE);
        const managed = manageRemoteSignal(io.signal);
        let recovery: RunRecovery | undefined;
        let redact = (value: string) => value;
        const safeText = (value: string) => terminalSafeText(redact(value));
        const jsonText = (value: unknown) =>
          JSON.stringify(value, (_key, item: unknown) =>
            typeof item === "string" ? redact(item) : item
          );
        try {
          const intent =
            command === "run"
              ? await prepareRunInput(values, {
                  cwd: io.cwd,
                  signal: managed.signal,
                  readStdin: dependencies.readStdin,
                })
              : undefined;
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
          redact = (text) => text.replaceAll(credential.token, "[redacted]");
          if (values.cursor?.includes(credential.token))
            return writeUsageError(io, "Pass a valid run-following cursor.", CLOUD_USAGE);
          const client = createCloudClient({
            host,
            token: credential.token,
            fetch: dependencies.fetch,
            signal: managed.signal,
          });
          let workspace = values.workspace;
          let session: CliSession | undefined;
          if (!workspace) {
            if (isCloudAutomationToken(credential.token))
              throw new Error(
                "Automation credentials require --workspace <id>; session workspace discovery is unavailable."
              );
            session = await client.session();
            if (session.workspaces.length === 0)
              throw new Error(
                "No Cloud workspaces are available. Create or join a workspace in the Cloud dashboard, then try again."
              );
            if (session.workspaces.length !== 1)
              throw new Error(
                `Choose a workspace with --workspace <id>:\n${session.workspaces.map((item) => `${item.name} (${item.id})`).join("\n")}`
              );
            workspace = session.workspaces[0].id;
          }
          const follow = async (target: RunRecovery, initial?: CliRun) => {
            const observation = {
              client,
              workspace: target.workspaceId,
              runId: target.runId,
              initial,
              io,
              safeText,
              signal: managed.signal,
              sleep: dependencies.sleep ?? cloudSleep,
              json: Boolean(values.json),
            };
            if (values.poll) return pollCloudRun(observation);
            await client.requireRunFollowing(target.workspaceId, session);
            return streamCloudRun(observation, target);
          };
          const printRun = (run: CliRun) => {
            if (values.json) io.stdout.write(`${jsonText(run)}\n`);
            else {
              io.stdout.write(`Run ${safeText(run.id)}: ${run.status}\n`);
              if (run.result !== undefined)
                io.stdout.write(`${terminalSafeText(jsonText(run.result))}\n`);
              if (run.error) io.stderr.write(`${safeText(run.error)}\n`);
            }
            return runExit(run);
          };
          if (command === "list") {
            const pipelines = await client.pipelines(workspace);
            if (values.json) io.stdout.write(`${jsonText(pipelines)}\n`);
            else
              for (const pipeline of pipelines)
                io.stdout.write(
                  `${safeText(pipeline.slug)}: ${safeText(pipeline.name)} (${safeText(pipeline.id)}) ${pipeline.available ? "available" : "unavailable"} commit=${safeText(pipeline.commit)} branch=${safeText(pipeline.branch)}\n`
                );
            return 0;
          }
          if (command === "follow" || values.follow) {
            recovery = { host, workspaceId: workspace, runId: selector, cursor: values.cursor };
          }
          if (command === "follow") return printRun(await follow(recovery!));
          if (command === "logs") {
            const run = recovery
              ? await follow(recovery)
              : await client.getRun(workspace, selector);
            if (!recovery && !values.json)
              for (const log of run.logs)
                await writeCloudLog(io.stdout, log, safeText, managed.signal);
            if (values.json)
              io.stdout.write(
                `${jsonText({ id: run.id, pipelineId: run.pipelineId, status: run.status, logs: run.logs })}\n`
              );
            else
              io.stdout.write(
                `Run ${safeText(run.id)}: ${run.status}\n${runUrl(host, redact(workspace), redact(run.id))}\n`
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
            pipelineId = matches[0].id;
          }
          const { input, source, idempotencyKey: key } = intent!;
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
                `Admission could not be confirmed. Workspace: ${safeText(workspace)}; idempotency key: ${safeText(key)}. Host: ${safeText(host)}; pipeline ID: ${safeText(pipelineId)}. Retry with --idempotency-key ${safeText(key)}, the same --id, --host and --workspace, and identical input and source selection (--ref or --source) under the same principal. Do not start a fresh run.\n`
              );
            }
            throw error;
          }
          recovery = { host, workspaceId: workspace, runId: run.id };
          const progress = values.json ? io.stderr : io.stdout;
          progress.write(
            `Run ${safeText(run.id)}: ${safeText(run.pipelineName)}\nWorkspace: ${safeText(workspace)}\nSource commit: ${safeText(run.commit)}\n${runUrl(host, redact(workspace), redact(run.id))}\nLocal changes are not used.\n${source ? `Requested source: ${safeText(JSON.stringify(source))}\n` : ""}`
          );
          if (values.detach) {
            if (values.json) io.stdout.write(`${jsonText(run)}\n`);
            return 0;
          }
          return printRun(await follow(recovery, run));
        } catch (error) {
          if (error instanceof CloudRunUsageError)
            return writeUsageError(io, error.message, CLOUD_USAGE);
          if (!recovery)
            return cloudErrorExit(
              error instanceof CloudClientError ? error : new Error(redact(errorMessage(error))),
              io,
              managed.signal
            );
          const failure = observationError(error, managed.signal);
          const detail =
            command === "run" && failure.code === "forbidden"
              ? " The run was admitted. Following requires read scope. Use --detach for run-only credentials."
              : "";
          if (values.json)
            io.stderr.write(
              `${jsonText({
                type: "cloud_follow_error",
                error: {
                  code: failure.code,
                  message: failure.message + detail,
                  status: failure.status,
                },
                recovery,
              })}\n`
            );
          else {
            io.stderr.write(
              `Run ${safeText(recovery.runId)}\n${runUrl(recovery.host, redact(recovery.workspaceId), redact(recovery.runId))}\n`
            );
            if (recovery.cursor)
              io.stderr.write(
                `Resume with cloud follow and --cursor ${safeText(recovery.cursor)}.\n`
              );
            io.stderr.write(`Error: ${safeText(failure.message + detail)}\n`);
          }
          return cloudErrorExit(failure, io, managed.signal, false);
        } finally {
          managed.cleanup();
        }
      },
    },
    argv,
    io
  );
}
