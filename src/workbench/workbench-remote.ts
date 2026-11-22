import {
  HOSTED_EXECUTIONS_PATH,
  HOSTED_EXECUTION_REASONS,
  HOSTED_EXECUTION_STATES,
  isLaunchIdentifier,
  type HostedExecutionStatus,
} from "../hosting/execution-status.js";
import { parseStudioLaunchRequest } from "../studio/shared/protocol.js";
import { abortableSleep } from "../utilities/abort.js";
import { isJsonObject } from "../utilities/canonical-json.js";
import { readBoundedBody } from "../utilities/read-body.js";
import { withRetry } from "../utilities/retry.js";
import { readCliJson, type CliInputContext } from "./workbench-json-input.js";
import { manageRemoteSignal, normalizeRemoteOrigin } from "./workbench-remote-io.js";
import { WORKBENCH_SPECS } from "./workbench-command-specs.js";
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

class HostedRequestError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message);
  }
}

function uncertain(error: unknown): boolean {
  return (
    !(error instanceof HostedRequestError) || error.status === undefined || error.status >= 500
  );
}

function accessHeaders(host: string, env: Readonly<Record<string, string | undefined>>): Headers {
  const id = env.CF_ACCESS_CLIENT_ID;
  const secret = env.CF_ACCESS_CLIENT_SECRET;
  const headers = new Headers({ accept: "application/json" });
  if (host.startsWith("http:")) return headers;
  if (!id || !secret)
    throw new Error("Set CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET for this origin.");
  headers.set("CF-Access-Client-Id", id);
  headers.set("CF-Access-Client-Secret", secret);
  return headers;
}

async function requestExecution(
  fetcher: typeof fetch,
  host: string,
  headers: Headers,
  signal: AbortSignal,
  path: string,
  method: "GET" | "POST",
  body?: string
): Promise<unknown> {
  const requestHeaders = new Headers(headers);
  if (method === "POST") requestHeaders.set("x-tubeless-execution", "1");
  if (body !== undefined) requestHeaders.set("content-type", "application/json");
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
  const response = await fetcher(`${host}${HOSTED_EXECUTIONS_PATH}${path}`, {
    method,
    body,
    headers: requestHeaders,
    redirect: "manual",
    signal: deadline,
  });
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    throw new HostedRequestError(
      "The Worker redirected the request. Check the host and Access Service Auth policy.",
      response.status
    );
  }
  let data: unknown;
  try {
    const bytes = await readBoundedBody(response.body, 65_536, deadline);
    data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    if (response.ok)
      throw new HostedRequestError("The Worker returned an invalid execution response.");
  }
  if (response.ok) return data;
  const error = isJsonObject(data) ? data : {};
  const diagnostics = Array.isArray(error.errors)
    ? error.errors
        .filter((item): item is string => typeof item === "string")
        .slice(0, 5)
        .join(" ")
    : "";
  const message = diagnostics || (typeof error.message === "string" ? error.message : "");
  const original = isLaunchIdentifier(error.executionId) ? ` Execution ${error.executionId}.` : "";
  throw new HostedRequestError(
    `Worker returned HTTP ${response.status}.${message ? ` ${message}` : ""}${original}`,
    response.status
  );
}

function executionStatus(data: unknown, id: string): HostedExecutionStatus {
  if (!isJsonObject(data))
    throw new HostedRequestError("The Worker returned an invalid execution status.");
  const { commandId, cancellationRequested, runId } = data;
  const state = HOSTED_EXECUTION_STATES.find((state) => state === data.state);
  const reason = HOSTED_EXECUTION_REASONS.find((reason) => reason === data.reason);
  if (
    data.executionId !== id ||
    typeof commandId !== "string" ||
    !state ||
    typeof cancellationRequested !== "boolean" ||
    (runId !== undefined && typeof runId !== "string") ||
    (data.reason !== undefined && !reason)
  ) {
    throw new HostedRequestError("The Worker returned an invalid execution status.");
  }
  return {
    executionId: id,
    commandId,
    state,
    cancellationRequested,
    ...(runId === undefined ? {} : { runId }),
    ...(reason === undefined ? {} : { reason }),
  };
}

async function prepareSubmission(
  commandId: string,
  args: { "input-file"?: string; "idempotency-key"?: string },
  context: CliInputContext
) {
  const file = args["input-file"];
  if (file === "") throw new Error("Pass a nonempty --input-file path, or - for stdin.");
  const idempotencyKey = args["idempotency-key"] ?? crypto.randomUUID();
  if (!isLaunchIdentifier(idempotencyKey))
    throw new Error(
      "Use 1–200 letters, digits, periods, underscores, colons or hyphens for the idempotency key."
    );
  const request = parseStudioLaunchRequest({
    values: file ? await readCliJson(file, context, "Input") : {},
  });
  if (!request)
    throw new Error(
      "Input must contain bounded string, number, boolean, string-array or number-array command parameters."
    );
  const body = JSON.stringify({ commandId, values: request.values, idempotencyKey });
  if (new TextEncoder().encode(body).byteLength > 65_536)
    throw new Error("The submission must fit within 64 KiB.");
  return { body, idempotencyKey };
}

function showStatus(
  status: HostedExecutionStatus,
  host: string,
  json: boolean,
  io: WorkbenchCliIo
): void {
  if (json) {
    io.stdout.write(`${JSON.stringify(status)}\n`);
    return;
  }
  const { executionId, state, cancellationRequested, runId, reason } = status;
  const cancelling =
    state === "running" && cancellationRequested ? " (cancellation requested)" : "";
  io.stdout.write(
    `Execution ${executionId}: ${state}${cancelling}${reason ? ` (${terminalSafeText(reason)})` : ""}\n`
  );
  if (runId !== undefined) io.stdout.write(`${host}/?run=${encodeURIComponent(runId)}\n`);
}

export async function runRemote(
  argv: readonly string[],
  io: WorkbenchCliIo,
  dependencies: {
    fetch?: typeof fetch;
    env?: Readonly<Record<string, string | undefined>>;
    sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
    readStdin?: () => Promise<string>;
  } = {}
): Promise<number> {
  return runWorkbenchSubcommand(
    {
      spec: SPEC,
      parse: (args) => parseSubcommandArgs(args, SPEC.options),
      positionalCountError: {
        count: 2,
        message: "Pass a subcommand and one command or execution ID.",
      },
      async run({ values, positionals: [operation, target] }, commandIo) {
        if (operation !== "run" && operation !== "status" && operation !== "cancel")
          return writeUsageError(
            commandIo,
            "Choose remote run, status or cancel.",
            renderWorkbenchUsage(SPEC)
          );
        if (operation !== "run" && !isLaunchIdentifier(target))
          return writeUsageError(
            commandIo,
            "Pass the execution ID from an admission receipt.",
            renderWorkbenchUsage(SPEC, operation)
          );
        let host: string;
        try {
          if (!values.host) throw new Error("Pass the self-hosted Worker origin with --host.");
          host = normalizeRemoteOrigin(values.host, "Worker host");
        } catch (error) {
          return writeUsageError(
            commandIo,
            errorMessage(error),
            renderWorkbenchUsage(SPEC, operation)
          );
        }
        const managed = manageRemoteSignal(commandIo.signal);
        const { signal } = managed;
        let executionId = operation === "run" ? undefined : target;
        let pendingKey: string | undefined;
        try {
          const headers = accessHeaders(host, dependencies.env ?? process.env);
          const fetcher = dependencies.fetch ?? fetch;
          const send = (path: string, method: "GET" | "POST" = "GET", body?: string) =>
            requestExecution(fetcher, host, headers, signal, path, method, body);
          if (operation === "run") {
            let submission;
            try {
              submission = await prepareSubmission(target, values, {
                cwd: commandIo.cwd,
                signal,
                readStdin: dependencies.readStdin,
              });
            } catch (error) {
              if (signal.aborted) throw error;
              commandIo.stderr.write(`${terminalSafeText(errorMessage(error))}\n`);
              return 4;
            }
            pendingKey = submission.idempotencyKey;
            executionId = await withRetry(
              async () => {
                const receipt = await send("", "POST", submission.body);
                if (!isJsonObject(receipt) || !isLaunchIdentifier(receipt.executionId))
                  throw new HostedRequestError("The Worker returned an invalid admission receipt.");
                return receipt.executionId;
              },
              { maxAttempts: 2, baseDelayMs: 0, signal, shouldRetry: uncertain }
            );
            if (values.detach) {
              commandIo.stdout.write(
                values.json ? `${JSON.stringify({ executionId })}\n` : `${executionId}\n`
              );
              return 0;
            }
            commandIo.stderr.write(`Admitted execution ${executionId}.\n`);
          }
          const id = executionId ?? target;
          const path = `/${encodeURIComponent(id)}`;
          const follow = operation === "run" || values.follow === true;
          const initial =
            operation === "cancel" ? await send(`${path}/cancel`, "POST") : await send(path);
          let status = executionStatus(initial, id);
          while (follow && (status.state === "queued" || status.state === "running")) {
            if (dependencies.sleep) await dependencies.sleep(2_000, signal);
            else await abortableSleep(2_000, signal, "Follow execution");
            status = executionStatus(await send(path), id);
          }
          showStatus(status, host, values.json ?? false, commandIo);
          return !follow || status.state === "completed" ? 0 : status.state === "cancelled" ? 7 : 6;
        } catch (error) {
          if (pendingKey && !executionId && uncertain(error))
            commandIo.stderr.write(
              `Admission could not be confirmed. Retry on ${host} with the same command, inputs and --idempotency-key ${pendingKey}.\n`
            );
          if (executionId && operation === "run")
            commandIo.stderr.write(`Follow execution ${executionId} with remote status.\n`);
          if (signal.aborted) {
            commandIo.stderr.write("Stopped waiting locally. Remote work may continue.\n");
            return 7;
          }
          commandIo.stderr.write(`${terminalSafeText(errorMessage(error))}\n`);
          if (error instanceof HostedRequestError && (error.status === 400 || error.status === 413))
            return 4;
          if (error instanceof HostedRequestError && error.status === 409) return 6;
          return 2;
        } finally {
          managed.cleanup();
        }
      },
    },
    argv,
    io
  );
}
