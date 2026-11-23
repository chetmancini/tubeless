import { isLaunchIdentifier } from "../hosting/execution-status.js";
import type { CloudCommandDependencies } from "./cloud/shared.js";
import type { RemoteExecution } from "./remote/execution.js";
import type { RemoteProcess } from "./remote/process.js";
import { remoteDirectory, selectRemote, type RemoteDestination } from "./remote/profiles.js";
import { WORKBENCH_SPECS } from "./workbench-command-specs.js";
import { manageRemoteSignal, normalizeRemoteOrigin } from "./workbench-remote-io.js";
import {
  errorMessage,
  terminalSafeText,
  writeUsageError,
  type WorkbenchCliIo,
} from "./workbench-shared.js";
import {
  parseSubcommandArgs,
  renderWorkbenchUsage,
  runWorkbenchSubcommand,
} from "./workbench-subcommand.js";

const SPEC = WORKBENCH_SPECS.remote;
const parse = (args: readonly string[]) => parseSubcommandArgs(args, SPEC.options);
type Values = ReturnType<typeof parse>["values"];

function executionRequest(
  operation: string,
  args: readonly string[],
  values: Values
): RemoteExecution {
  if (operation === "runner") {
    if (args.length) throw new Error("Use --project to select the runner project.");
    const deploymentId = values["deployment-id"];
    if (!isLaunchIdentifier(deploymentId))
      throw new Error("Pass the exact Worker revision with --deployment-id.");
    return { kind: operation, deploymentId, projectFile: values.project ?? "tubeless.project.ts" };
  }
  if (operation !== "run" && operation !== "status" && operation !== "cancel")
    throw new Error("Choose remote connect, create, list, run, status, cancel or runner.");
  if (args.length !== 1) throw new Error("Pass one command or execution ID.");
  const id = args[0];
  if (operation === "run") return { ...values, kind: operation, commandId: id };
  if (!isLaunchIdentifier(id)) throw new Error("Pass the execution ID from an admission receipt.");
  return { ...values, kind: operation, executionId: id };
}

async function resolveDestination(directory: string, values: Values): Promise<RemoteDestination> {
  if (values.host === undefined) return selectRemote(directory, values.remote);
  if (values.remote !== undefined) throw new Error("Choose --host or --remote.");
  return {
    provider: "cloudflare",
    host: normalizeRemoteOrigin(values.host, "Worker host"),
    access: "service",
  };
}

export async function runRemote(
  argv: readonly string[],
  io: WorkbenchCliIo,
  dependencies: CloudCommandDependencies & { execute?: RemoteProcess } = {}
): Promise<number> {
  return runWorkbenchSubcommand(
    {
      spec: SPEC,
      parse,
      async run({ values, positionals: [operation, ...args] }, commandIo) {
        const env = dependencies.env ?? process.env;
        const directory = remoteDirectory(env);
        const context = { io: commandIo, env, execute: dependencies.execute };
        const usage = renderWorkbenchUsage(SPEC, operation);
        if (operation === "connect" || operation === "create" || operation === "list") {
          if (args.length > (operation === "connect" ? 1 : 0))
            return writeUsageError(
              commandIo,
              operation === "connect"
                ? "Pass at most one Studio URL."
                : `remote ${operation} takes no positional arguments.`,
              usage
            );
          const managed = manageRemoteSignal(commandIo.signal);
          try {
            const { setupRemote } = await import("./remote/setup.js");
            return await setupRemote(operation, args[0], values, {
              ...context,
              signal: managed.signal,
              directory,
              dependencies,
            });
          } catch (error) {
            commandIo.stderr.write(`${terminalSafeText(errorMessage(error))}\n`);
            return managed.signal.aborted ? 7 : 2;
          } finally {
            managed.cleanup();
          }
        }

        let request: RemoteExecution;
        let destination: RemoteDestination;
        try {
          request = executionRequest(operation, args, values);
          destination = await resolveDestination(directory, values);
          if (destination.provider === "tubeless-cloud") {
            if (request.kind === "runner")
              throw new Error("Select a self-hosted Cloudflare remote to enroll a Bun runner.");
            const { host, workspaceId: workspace } = destination;
            if (request.kind === "cancel") {
              const { cloudOutput } = await import("./cloud/output.js");
              throw new Error(
                `Cancel this run in Tubeless Cloud: ${cloudOutput().runUrl(host, workspace, request.executionId)}`
              );
            }
            if (values.poll && (request.kind === "run" ? request.detach : !request.follow))
              throw new Error("Use --poll with an attached run or remote status --follow.");
            const observation = { kind: values.poll ? ("poll" as const) : ("stream" as const) };
            const { runCloudCommand } = await import("./cloud/command.js");
            return await runCloudCommand(
              {
                host,
                workspace,
                json: request.json,
                action:
                  request.kind === "run"
                    ? {
                        kind: "run",
                        pipeline: { name: request.commandId },
                        input: request,
                        mode: request.detach ? undefined : observation,
                      }
                    : {
                        kind: "logs",
                        runId: request.executionId,
                        mode: request.follow ? observation : undefined,
                      },
              },
              commandIo,
              dependencies
            );
          }
          if (values.poll) throw new Error("--poll is only supported for Tubeless Cloud remotes.");
        } catch (error) {
          return writeUsageError(commandIo, errorMessage(error), usage);
        }
        const { executeOnWorker } = await import("./remote/execution.js");
        return executeOnWorker(destination, request, context, dependencies);
      },
    },
    argv,
    io
  );
}
