import { manageRemoteSignal } from "../workbench-remote-io.js";
import { WORKBENCH_SPECS } from "../workbench-command-specs.js";
import {
  renderWorkbenchUsage,
  parseSubcommandArgs,
  runWorkbenchSubcommand,
} from "../workbench-subcommand.js";
import { createCloudClient, isCloudTransportError, type CloudClient } from "./client.js";
import { resolveCloudHost } from "./config.js";
import { resolveCloudCredential } from "./credentials.js";
import { isFollowCursor } from "./follow-protocol.js";
import { pollCloudRun, streamCloudRun, writeCloudLog, type ObservationContext } from "./follow.js";
import { cloudOutput } from "./output.js";
import {
  prepareRunInput,
  CloudRunUsageError,
  type CloudRunInputArguments,
  type PreparedCloudRunInput,
} from "./run-input.js";
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
import {
  cloudErrorCode,
  cloudErrorExit,
  cloudSleep,
  type CloudCommandDependencies,
} from "./shared.js";

const CLOUD_SPEC = WORKBENCH_SPECS.cloud;
const CLOUD_USAGE = renderWorkbenchUsage(CLOUD_SPEC);
const parseArgs = (args: readonly string[]) => parseSubcommandArgs(args, CLOUD_SPEC.options);

type ObservationMode = { kind: "stream"; cursor?: string } | { kind: "poll" };
type PipelineSelector = { id: string } | { name: string };
type CloudAction<Input = PreparedCloudRunInput> =
  | { kind: "list" }
  | { kind: "logs"; runId: string; mode?: ObservationMode }
  | { kind: "follow"; runId: string; mode: ObservationMode }
  | {
      kind: "run";
      pipeline: PipelineSelector;
      input: Input;
      mode?: ObservationMode;
    };

type CloudCliAction = CloudAction<CloudRunInputArguments> | { kind: "reproduce"; path: string };

function parseAction({ values, positionals }: ReturnType<typeof parseArgs>): CloudCliAction {
  const [command, selector] = positionals;
  if (!CLOUD_SPEC.subcommands.some((name) => name === command))
    throw new CloudRunUsageError(`Pass one of: ${CLOUD_SPEC.subcommands.join(", ")}.`);
  if (command === "reproduce") {
    if (positionals.length !== 2)
      throw new CloudRunUsageError("Pass one reproduction manifest file.");
    if (!values.execute)
      throw new CloudRunUsageError("Pass --execute to authorize running the pinned source.");
    return { kind: "reproduce", path: selector };
  }

  const wanted =
    command === "logs" || command === "follow" || (command === "run" && !values.id) ? 2 : 1;
  if (positionals.length !== wanted)
    throw new CloudRunUsageError("Pass exactly the required command arguments.");
  if (values.workspace !== undefined && !values.workspace.trim())
    throw new CloudRunUsageError("Pass a nonempty workspace ID.");

  if (command === "list") return { kind: "list" };
  if (command === "run") {
    if (values.id !== undefined && !values.id.trim())
      throw new CloudRunUsageError("Pass a nonempty pipeline ID.");
    if (values.poll && values.detach)
      throw new CloudRunUsageError("--poll cannot be combined with --detach or --cursor.");
    return {
      kind: "run",
      pipeline: values.id === undefined ? { name: selector } : { id: values.id },
      input: values,
      mode: values.detach ? undefined : { kind: values.poll ? "poll" : "stream" },
    };
  }

  if (!selector.trim()) throw new CloudRunUsageError("Pass a nonempty run ID.");
  if (command === "logs" && !values.follow) {
    if (values.poll || values.cursor !== undefined)
      throw new CloudRunUsageError("Pass --follow to observe an existing run with cloud logs.");
    return { kind: "logs", runId: selector };
  }
  if (values.cursor !== undefined) {
    if (values.poll)
      throw new CloudRunUsageError("--poll cannot be combined with --detach or --cursor.");
    if (!isFollowCursor(values.cursor))
      throw new CloudRunUsageError("Pass a valid nonempty run-following cursor.");
  }
  return {
    kind: command === "follow" ? "follow" : "logs",
    runId: selector,
    mode: values.poll ? { kind: "poll" } : { kind: "stream", cursor: values.cursor },
  };
}

interface CloudContext extends ObservationContext {
  session?: CliSession;
}

async function resolveWorkspace(
  client: CloudClient,
  token: string,
  workspace?: string
): Promise<{ workspace: string; session?: CliSession }> {
  if (workspace) return { workspace };
  if (isCloudAutomationToken(token))
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
  return { workspace: session.workspaces[0].id, session };
}

async function selectPipeline(
  { client, workspace }: CloudContext,
  selector: PipelineSelector
): Promise<string> {
  if ("id" in selector) return selector.id;
  const pipelines = await client.pipelines(workspace);
  const matches = pipelines.filter(
    (item) => item.name === selector.name || item.slug === selector.name
  );
  if (matches.length === 0)
    throw new Error(
      "Cloud pipeline not found in this workspace. Use tubeless cloud list or the Cloud dashboard to select a loaded pipeline."
    );
  if (matches.length !== 1)
    throw new Error(
      `Multiple pipelines match ${JSON.stringify(selector.name)}. Choose --id <id>:\n${matches.map((item) => `${item.slug}: ${item.name} (${item.id})`).join("\n")}`
    );
  return matches[0].id;
}

function admissionUncertain(error: unknown): boolean {
  if (!(error instanceof CloudClientError)) return true;
  if (error.status === undefined && error.code === "invalid_request") return false;
  return error.status === undefined || error.status < 400 || error.status >= 500;
}

async function admitRun(
  { client, workspace, io, output, signal }: CloudContext,
  pipelineId: string,
  { input, source, idempotencyKey: key }: PreparedCloudRunInput
): Promise<CliRun> {
  if (signal.aborted) throw new Error("Run admission interrupted.");
  const request = { pipelineId, input, source };
  try {
    return await client.run(workspace, request, key).catch((error: unknown) => {
      if (!isCloudTransportError(error) || signal.aborted) throw error;
      return client.run(workspace, request, key);
    });
  } catch (error) {
    // An unusable or interrupted POST response can follow successful admission.
    if (admissionUncertain(error))
      io.stderr.write(
        `Admission could not be confirmed. Workspace: ${output.text(workspace)}; idempotency key: ${output.text(key)}. Host: ${output.text(client.host)}; pipeline ID: ${output.text(pipelineId)}. Retry with --idempotency-key ${output.text(key)}, the same --id, --host and --workspace, and identical input and source selection (--ref or --source) under the same principal. Do not start a fresh run.\n`
      );
    throw error;
  }
}

function printResult(context: CloudContext, run: CliRun, format: "run" | "logs"): void {
  const { client, workspace, io, json, output } = context;
  if (json) {
    const { id, pipelineId, status, logs } = run;
    io.stdout.write(`${output.json(format === "logs" ? { id, pipelineId, status, logs } : run)}\n`);
    return;
  }
  io.stdout.write(`Run ${output.text(run.id)}: ${run.status}\n`);
  if (format === "logs") {
    io.stdout.write(`${output.runUrl(client.host, workspace, run.id)}\n`);
    return;
  }
  if (run.result !== undefined) io.stdout.write(`${terminalSafeText(output.json(run.result))}\n`);
  if (run.error) io.stderr.write(`${output.text(run.error)}\n`);
}

function observationError(error: unknown, signal: AbortSignal): CloudClientError {
  if (signal.aborted)
    return new CloudClientError(
      "Stopped following Cloud activity. Remote work continues.",
      "observation_interrupted"
    );
  if (!(error instanceof CloudClientError))
    return new CloudClientError(errorMessage(error), "observation_error");
  return error.code === "timeout"
    ? new CloudClientError("Cloud observation timed out.", "observation_timeout")
    : error;
}

async function observeRun(
  context: CloudContext,
  runId: string,
  mode: ObservationMode,
  format: "run" | "logs",
  admission?: CliRun
): Promise<number> {
  const { client, workspace, io, json, output, signal, session } = context;
  const recovery = {
    host: client.host,
    workspaceId: workspace,
    runId,
    cursor: mode.kind === "stream" ? mode.cursor : undefined,
  };
  try {
    if (mode.kind === "stream") await client.requireRunFollowing(workspace, session);
    const run = await (mode.kind === "poll"
      ? pollCloudRun(context, runId, admission)
      : streamCloudRun(context, runId, recovery, admission));
    printResult(context, run, format);
    return run.status === "completed" ? 0 : run.status === "cancelled" ? 7 : 6;
  } catch (error) {
    const failure = observationError(error, signal);
    const detail =
      admission && failure.code === "forbidden"
        ? " The run was admitted. Following requires read scope. Use --detach for run-only credentials."
        : "";
    if (json) {
      io.stderr.write(
        `${output.json({
          type: "cloud_follow_error",
          error: { code: failure.code, message: failure.message + detail, status: failure.status },
          recovery,
        })}\n`
      );
    } else {
      io.stderr.write(
        `Run ${output.text(runId)}\n${output.runUrl(client.host, workspace, runId)}\n`
      );
      if (recovery.cursor)
        io.stderr.write(`Resume with cloud follow and --cursor ${output.text(recovery.cursor)}.\n`);
      io.stderr.write(`Error: ${output.text(failure.message + detail)}\n`);
    }
    return cloudErrorCode(failure, signal);
  }
}

async function executeAction(context: CloudContext, action: CloudAction): Promise<number> {
  const { client, workspace, io, json, output, signal } = context;
  switch (action.kind) {
    case "list": {
      const pipelines = await client.pipelines(workspace);
      if (json) io.stdout.write(`${output.json(pipelines)}\n`);
      else
        for (const pipeline of pipelines)
          io.stdout.write(
            `${output.text(pipeline.slug)}: ${output.text(pipeline.name)} (${output.text(pipeline.id)}) ${pipeline.available ? "available" : "unavailable"} commit=${output.text(pipeline.commit)} branch=${output.text(pipeline.branch)}\n`
          );
      return 0;
    }
    case "logs": {
      if (action.mode) return observeRun(context, action.runId, action.mode, "logs");
      const run = await client.getRun(workspace, action.runId);
      if (!json)
        for (const log of run.logs) await writeCloudLog(io.stdout, log, output.text, signal);
      printResult(context, run, "logs");
      return 0;
    }
    case "follow":
      return observeRun(context, action.runId, action.mode, "run");
    case "run": {
      const pipelineId = await selectPipeline(context, action.pipeline);
      const run = await admitRun(context, pipelineId, action.input);
      const progress = json ? io.stderr : io.stdout;
      const { source } = action.input;
      progress.write(
        `Run ${output.text(run.id)}: ${output.text(run.pipelineName)}\nWorkspace: ${output.text(workspace)}\nSource commit: ${output.text(run.commit)}\n${output.runUrl(client.host, workspace, run.id)}\nLocal changes are not used.\n${source ? `Requested source: ${terminalSafeText(output.json(source))}\n` : ""}`
      );
      if (action.mode) return observeRun(context, run.id, action.mode, "run", run);
      if (json) io.stdout.write(`${output.json(run)}\n`);
      return 0;
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
      spec: CLOUD_SPEC,
      parse: parseArgs,
      run: async (parsed) => {
        let action;
        try {
          action = parseAction(parsed);
        } catch (error) {
          if (error instanceof CloudRunUsageError)
            return writeUsageError(
              io,
              error.message,
              renderWorkbenchUsage(CLOUD_SPEC, parsed.positionals[0])
            );
          throw error;
        }
        if (action.kind === "reproduce") {
          const { runReproduce } = await import("./reproduce.js");
          return runReproduce(action.path, io);
        }
        return runCloudCommand({ ...parsed.values, action }, io, dependencies);
      },
    },
    argv,
    io
  );
}

/** Execute a Cloud action from the Cloud CLI or a named remote. */
export async function runCloudCommand(
  request: {
    host?: string;
    workspace?: string;
    json?: boolean;
    action: CloudAction<CloudRunInputArguments>;
  },
  io: WorkbenchCliIo,
  dependencies: CloudCommandDependencies
): Promise<number> {
  const managed = manageRemoteSignal(io.signal);
  const { signal } = managed;
  let output = cloudOutput();
  try {
    const { action } = request;
    const prepared =
      action.kind === "run"
        ? {
            ...action,
            input: await prepareRunInput(action.input, {
              cwd: io.cwd,
              signal,
              readStdin: dependencies.readStdin,
            }),
          }
        : action;
    const host = resolveCloudHost(request.host);
    const credential = await resolveCloudCredential(host, dependencies);
    if (!credential)
      throw new Error(
        "No active Cloud credential. Run tubeless auth login or supply TUBELESS_TOKEN."
      );
    output = cloudOutput(credential.token);
    const mode = "mode" in action ? action.mode : undefined;
    if (mode?.kind === "stream" && mode.cursor?.includes(credential.token))
      throw new CloudRunUsageError("Pass a valid run-following cursor.");
    const client = createCloudClient({
      host,
      token: credential.token,
      fetch: dependencies.fetch,
      signal,
    });
    return await executeAction(
      {
        client,
        ...(await resolveWorkspace(client, credential.token, request.workspace)),
        io,
        output,
        signal,
        json: Boolean(request.json),
        sleep: dependencies.sleep ?? cloudSleep,
      },
      prepared
    );
  } catch (error) {
    if (error instanceof CloudRunUsageError) return writeUsageError(io, error.message, CLOUD_USAGE);
    return cloudErrorExit(error, io, signal, output.text);
  } finally {
    managed.cleanup();
  }
}
