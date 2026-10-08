import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { createCloudClient, CloudClientError } from "./cloud-client.js";
import {
  resolveCloudHost,
  readCloudConfig,
  writeCloudConfig,
  findGitRoot,
  normalizeCloudSourcePath,
} from "./cloud-config.js";
import { resolveCloudCredential } from "./cloud-credentials.js";
import type { CliRun, CliPipeline, CloudJsonValue } from "./cloud-protocol.js";
import { runWorkbenchSubcommand } from "./workbench-subcommand.js";
import { type WorkbenchCliIo, writeUsageError, writeCliChunk } from "./workbench-shared.js";
import {
  cloudErrorExit,
  cloudSignal,
  cloudSleep,
  type CloudCommandDependencies,
} from "./workbench-cloud-shared.js";

const CLOUD_USAGE = `Usage: tubeless cloud <link|list|add|run|logs> [options]

  link --workspace <id> --repository <owner/name> [--branch <name>]
  list [--json]
  add <path> [--name <name>] [--export <name>] [--pipeline-id <id>] [--registry <path>]
  run <path> [--export <name>] [--pipeline-id <id>] [--input-file <path|->] [--detach] [--json]
  run --id <cloud-pipeline-id> [--input-file <path|->] [--detach] [--json]
  logs <run-id> [--follow] [--json]

All commands accept --workspace <id>, --host <origin>, and --help.
Remote runs use deployed code. Local edits and modules are never loaded.
Set up workspaces and GitHub repository connections in the Cloud dashboard.
`;
const COMMON_OPTIONS = ["host", "workspace", "help"];
const COMMAND_OPTIONS: Record<string, string[]> = {
  link: ["repository", "branch"],
  list: ["json"],
  add: ["name", "export", "pipeline-id", "registry"],
  run: ["id", "export", "pipeline-id", "input-file", "detach", "json"],
  logs: ["follow", "json"],
};
const INPUT_LIMIT = 64 * 1024;

async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new Error("Input read interrupted.");
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(new Error("Input read interrupted."));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}

async function boundedInput(
  file: string,
  cwd: string,
  dependencies: CloudCommandDependencies,
  signal: AbortSignal
): Promise<Record<string, CloudJsonValue>> {
  let text: string;
  if (file === "-") {
    if (dependencies.readStdin) text = await abortable(dependencies.readStdin(), signal);
    else {
      text = await new Promise<string>((resolve, reject) => {
        const chunks: Buffer[] = [];
        let size = 0;
        const cleanup = () => {
          process.stdin.off("data", onData);
          process.stdin.off("end", onEnd);
          process.stdin.off("error", onError);
          signal.removeEventListener("abort", onAbort);
          process.stdin.pause();
        };
        const onError = (error: Error) => {
          cleanup();
          reject(error);
        };
        const onAbort = () => onError(new Error("Input read interrupted."));
        const onData = (chunk: Buffer | string) => {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += bytes.length;
          if (size > INPUT_LIMIT) {
            onError(new CloudClientError("Input JSON must be at most 64 KB.", "invalid_request"));
            return;
          }
          chunks.push(bytes);
        };
        const onEnd = () => {
          cleanup();
          resolve(Buffer.concat(chunks).toString("utf8"));
        };
        process.stdin.on("data", onData);
        process.stdin.once("end", onEnd);
        process.stdin.once("error", onError);
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
        else process.stdin.resume();
      });
    }
  } else {
    const fileHandle = await open(
      path.resolve(cwd, file),
      constants.O_RDONLY | constants.O_NONBLOCK
    );
    try {
      if (!(await fileHandle.stat()).isFile())
        throw new CloudClientError("Input file must be a regular file.", "invalid_request");
      const buffer = Buffer.alloc(INPUT_LIMIT + 1);
      let size = 0;
      while (size < buffer.length) {
        if (signal.aborted) throw new Error("Input read interrupted.");
        const read = await fileHandle.read(buffer, size, buffer.length - size, null);
        if (read.bytesRead === 0) break;
        size += read.bytesRead;
      }
      text = buffer.subarray(0, size).toString("utf8");
    } finally {
      await fileHandle.close();
    }
  }
  if (Buffer.byteLength(text) > INPUT_LIMIT)
    throw new CloudClientError("Input JSON must be at most 64 KB.", "invalid_request");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new CloudClientError("Input must be valid JSON.", "invalid_request");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new CloudClientError("Input must be a JSON object.", "invalid_request");
  // SAFETY: JSON.parse produced JSON and the object shape was checked above.
  return value as Record<string, CloudJsonValue>;
}

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
          `${new Date(log.time).toISOString()} ${log.level}: ${log.message}\n`,
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
      if (!(error instanceof CloudClientError) || error.status || ++failures >= 3) throw error;
    }
  }
}

function selectionDescription(pipeline: CliPipeline): string {
  return `${pipeline.id}: ${pipeline.path} export=${pipeline.exportName ?? "auto"} pipeline-id=${pipeline.pipelineId ?? "auto"} registry=${pipeline.registryPath ?? "none"}`;
}

export async function runCloud(
  argv: readonly string[],
  io: WorkbenchCliIo,
  dependencies: CloudCommandDependencies = {}
): Promise<number> {
  return runWorkbenchSubcommand(
    {
      usage: CLOUD_USAGE,
      parse: (args) =>
        parseArgs({
          args: [...args],
          allowPositionals: true,
          strict: true,
          options: {
            help: { type: "boolean", short: "h" },
            host: { type: "string" },
            workspace: { type: "string" },
            repository: { type: "string" },
            branch: { type: "string" },
            name: { type: "string" },
            export: { type: "string" },
            "pipeline-id": { type: "string" },
            registry: { type: "string" },
            id: { type: "string" },
            "input-file": { type: "string" },
            detach: { type: "boolean" },
            json: { type: "boolean" },
            follow: { type: "boolean" },
          },
        }),
      run: async ({ values, positionals }) => {
        const [command, selector] = positionals;
        if (!command || !COMMAND_OPTIONS[command])
          return writeUsageError(io, "Pass link, list, add, run, or logs.", CLOUD_USAGE);
        for (const option of Object.keys(values)) {
          if (![...COMMON_OPTIONS, ...COMMAND_OPTIONS[command]!].includes(option))
            return writeUsageError(
              io,
              `--${option} is not supported by cloud ${command}.`,
              CLOUD_USAGE
            );
        }
        const wanted =
          command === "add" || command === "logs" || (command === "run" && !values.id) ? 2 : 1;
        if (positionals.length !== wanted)
          return writeUsageError(io, "Pass exactly the required command arguments.", CLOUD_USAGE);
        if (values.id && (selector || values.export || values["pipeline-id"]))
          return writeUsageError(
            io,
            "--id cannot be combined with a path or source-selection flags.",
            CLOUD_USAGE
          );
        const managed = cloudSignal(io);
        let admitted: { id: string; url: string } | undefined;
        try {
          const linked = await readCloudConfig(io.cwd);
          const host = resolveCloudHost(values.host, linked?.config);
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
          const workspace = values.workspace ?? linked?.config.workspaceId;
          if (command === "link") {
            const session = await client.session();
            if (!values.workspace || !values.repository) {
              for (const item of session.workspaces) {
                io.stdout.write(`Workspace ${item.id}: ${item.name}\n`);
                if (values.workspace && item.id !== values.workspace) continue;
                for (const repository of await client.repositories(item.id)) {
                  io.stdout.write(
                    `  tubeless cloud link --host ${host} --workspace ${item.id} --repository ${repository.fullName} --branch ${repository.branch}\n`
                  );
                }
              }
              io.stdout.write("Connect missing repositories in the Cloud dashboard.\n");
              return 0;
            }
            if (!session.workspaces.some((item) => item.id === values.workspace))
              throw new Error(
                "Workspace membership has changed. Select a workspace from cloud link or the dashboard."
              );
            const repositories = await client.repositories(values.workspace);
            const repository = repositories.find(
              (item) => item.fullName.toLowerCase() === values.repository!.toLowerCase()
            );
            if (!repository)
              throw new Error(
                "Repository is not connected. Connect it in the Cloud dashboard, then link again."
              );
            const root = await findGitRoot(io.cwd, { required: true });
            if (!root) throw new Error("Run cloud link inside a Git repository.");
            await writeCloudConfig(root, {
              version: 1,
              host,
              workspaceId: values.workspace,
              repositoryId: repository.id,
              repository: repository.fullName,
              branch: values.branch ?? repository.branch,
            });
            io.stdout.write(
              `Linked ${repository.fullName} (${values.branch ?? repository.branch}) to workspace ${values.workspace} at ${host}.\n`
            );
            return 0;
          }
          if (!workspace)
            throw new Error("Select a workspace with --workspace or run tubeless cloud link.");
          if (command === "list") {
            const pipelines = await client.pipelines(workspace);
            if (values.json) io.stdout.write(`${JSON.stringify(pipelines)}\n`);
            else
              for (const pipeline of pipelines)
                io.stdout.write(
                  `${selectionDescription(pipeline)} branch=${pipeline.branch} commit=${pipeline.commit} ${pipeline.available ? "available" : "unavailable"}\n`
                );
            return 0;
          }
          if (command === "logs") {
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
                  `${new Date(log.time).toISOString()} ${log.level}: ${log.message}\n`,
                  managed.signal
                );
            if (values.json)
              io.stdout.write(
                `${JSON.stringify({ id: run.id, pipelineId: run.pipelineId, status: run.status, logs: run.logs })}\n`
              );
            else io.stdout.write(`Run ${run.id}: ${run.status}\n${admitted.url}\n`);
            return values.follow ? runExit(run) : 0;
          }
          let pipeline: CliPipeline;
          if (values.id) {
            const pipelines = await client.pipelines(workspace);
            const match = pipelines.find((item) => item.id === values.id);
            if (!match)
              throw new Error(
                "Cloud pipeline not found in this workspace. Use cloud list to select it."
              );
            pipeline = match;
          } else {
            if (!linked)
              throw new Error("Path selection requires a project link. Run tubeless cloud link.");
            const sourcePath = normalizeCloudSourcePath(linked.root, io.cwd, selector!);
            if (command === "add") {
              pipeline = await client.addPipeline(workspace, {
                repositoryId: linked.config.repositoryId,
                branch: linked.config.branch,
                path: sourcePath,
                name:
                  values.name ?? path.posix.basename(sourcePath, path.posix.extname(sourcePath)),
                ...(values.export ? { exportName: values.export } : {}),
                ...(values["pipeline-id"] ? { pipelineId: values["pipeline-id"] } : {}),
                ...(values.registry
                  ? { registryPath: normalizeCloudSourcePath(linked.root, io.cwd, values.registry) }
                  : {}),
              });
              io.stdout.write(
                `Registered ${pipeline.name} (${pipeline.id})\nWorkspace: ${workspace}\nDeployed commit: ${pipeline.commit}\n`
              );
              return 0;
            }
            const matches = (await client.pipelines(workspace)).filter(
              (item) =>
                item.repositoryId === linked.config.repositoryId &&
                item.branch === linked.config.branch &&
                item.path === sourcePath &&
                (!values.export || item.exportName === values.export) &&
                (!values["pipeline-id"] || item.pipelineId === values["pipeline-id"])
            );
            if (matches.length === 0)
              throw new Error(
                `No registration for ${sourcePath}. Register it with tubeless cloud add ${sourcePath}.`
              );
            if (matches.length !== 1)
              throw new Error(
                `Ambiguous source selection. Choose --export, --pipeline-id, or --id:\n${matches.map(selectionDescription).join("\n")}`
              );
            pipeline = matches[0]!;
          }
          const input = values["input-file"]
            ? await boundedInput(values["input-file"], io.cwd, dependencies, managed.signal)
            : {};
          if (managed.signal.aborted) throw new Error("Run admission interrupted.");
          const key = randomUUID();
          let run: CliRun;
          try {
            try {
              run = await client.run(workspace, { pipelineId: pipeline.id, input }, key);
            } catch (error) {
              if (!(error instanceof CloudClientError) || error.status || managed.signal.aborted)
                throw error;
              run = await client.run(workspace, { pipelineId: pipeline.id, input }, key);
            }
          } catch (error) {
            // Only an explicit 4xx establishes a rejected request. A 5xx,
            // unusable success response or interruption can follow admission.
            const status = error instanceof CloudClientError ? error.status : undefined;
            if (status === undefined || status < 400 || status >= 500) {
              io.stderr.write(
                `Admission could not be confirmed. Workspace: ${workspace}; idempotency key: ${key}. Retry only with this same key through the API.\n`
              );
            }
            throw error;
          }
          admitted = { id: run.id, url: runUrl(host, workspace, run.id) };
          const progress = values.json ? io.stderr : io.stdout;
          progress.write(
            `Run ${run.id}: ${run.pipelineName}\nWorkspace: ${workspace}\nDeployed commit: ${run.commit}\n${admitted.url}\nLocal changes are not used.\n`
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
            io.stdout.write(`Run ${run.id}: ${run.status}\n`);
            if (run.result !== undefined) io.stdout.write(`${JSON.stringify(run.result)}\n`);
            if (run.error) io.stderr.write(`${run.error}\n`);
          }
          return runExit(run);
        } catch (error) {
          if (admitted) io.stderr.write(`Run ${admitted.id}\n${admitted.url}\n`);
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
