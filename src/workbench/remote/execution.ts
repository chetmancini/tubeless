import {
  HOSTED_EXECUTIONS_PATH,
  HOSTED_EXECUTION_REASONS,
  HOSTED_EXECUTION_STATES,
  isLaunchIdentifier,
  type HostedExecutionStatus,
} from "../../hosting/execution-status.js";
import { parseStudioLaunchRequest } from "../../studio/shared/protocol.js";
import { abortableSleep } from "../../utilities/abort.js";
import { isJsonObject } from "../../utilities/canonical-json.js";
import { readBoundedBody } from "../../utilities/read-body.js";
import { withRetry } from "../../utilities/retry.js";
import { readCliJson, type CliInputContext } from "../workbench-json-input.js";
import { manageRemoteSignal } from "../workbench-remote-io.js";
import { errorMessage, terminalSafeText, type WorkbenchCliIo } from "../workbench-shared.js";
import type { CloudCommandDependencies } from "../cloud/shared.js";
import { workerHeaders } from "./access.js";
import type { RemoteProcessContext } from "./process.js";
import type { WorkerRemote } from "./profiles.js";

export type RemoteExecution =
  | { kind: "runner"; projectFile: string; deploymentId: string }
  | ({ json?: boolean } & (
      | { kind: "status"; executionId: string; follow?: boolean }
      | { kind: "cancel"; executionId: string }
      | {
          kind: "run";
          commandId: string;
          "input-file"?: string;
          "idempotency-key"?: string;
          detach?: boolean;
        }
    ));

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
  const { commandId, cancellationRequested, runId, target } = data;
  const state = HOSTED_EXECUTION_STATES.find((state) => state === data.state);
  const reason = HOSTED_EXECUTION_REASONS.find((reason) => reason === data.reason);
  if (
    data.executionId !== id ||
    typeof commandId !== "string" ||
    !state ||
    typeof cancellationRequested !== "boolean" ||
    (runId !== undefined && typeof runId !== "string") ||
    (data.reason !== undefined && !reason) ||
    (target !== undefined && target !== "cloudflare" && target !== "local")
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
    ...(target === undefined ? {} : { target }),
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
  const { executionId, state, cancellationRequested, runId, reason, target } = status;
  const cancelling =
    state === "running" && cancellationRequested ? " (cancellation requested)" : "";
  io.stdout.write(
    `Execution ${executionId}: ${state}${target ? ` on ${target}` : ""}${cancelling}${reason ? ` (${terminalSafeText(reason)})` : ""}\n`
  );
  if (runId !== undefined) io.stdout.write(`${host}/?run=${encodeURIComponent(runId)}\n`);
}

export async function executeOnWorker(
  { host, access }: WorkerRemote,
  request: RemoteExecution,
  context: Omit<RemoteProcessContext, "signal">,
  dependencies: CloudCommandDependencies
): Promise<number> {
  const { io } = context;
  const managed = manageRemoteSignal(io.signal);
  const { signal } = managed;
  let admittedId: string | undefined;
  let pendingKey: string | undefined;
  try {
    const headers = await workerHeaders(
      host,
      { ...context, signal },
      request.kind === "runner" ? "service" : access
    );
    const fetcher = dependencies.fetch ?? fetch;
    if (request.kind === "runner") {
      const { runRemoteRunner } = await import("../workbench-remote-runner.js");
      return await runRemoteRunner({
        host,
        projectFile: request.projectFile,
        deploymentId: request.deploymentId,
        io,
        fetcher,
        headers,
        signal,
        sleep: dependencies.sleep,
      });
    }
    const send = (path: string, method: "GET" | "POST" = "GET", body?: string) =>
      requestExecution(fetcher, host, headers, signal, path, method, body);
    let id: string;
    if (request.kind === "run") {
      let submission;
      try {
        submission = await prepareSubmission(request.commandId, request, {
          cwd: io.cwd,
          signal,
          readStdin: dependencies.readStdin,
        });
      } catch (error) {
        if (signal.aborted) throw error;
        io.stderr.write(`${terminalSafeText(errorMessage(error))}\n`);
        return 4;
      }
      pendingKey = submission.idempotencyKey;
      id = await withRetry(
        async () => {
          const receipt = await send("", "POST", submission.body);
          if (!isJsonObject(receipt) || !isLaunchIdentifier(receipt.executionId))
            throw new HostedRequestError("The Worker returned an invalid admission receipt.");
          return receipt.executionId;
        },
        { maxAttempts: 2, baseDelayMs: 0, signal, shouldRetry: uncertain }
      );
      admittedId = id;
      if (request.detach) {
        io.stdout.write(request.json ? `${JSON.stringify({ executionId: id })}\n` : `${id}\n`);
        return 0;
      }
      io.stderr.write(`Admitted execution ${id}.\n`);
    } else id = request.executionId;
    const path = `/${encodeURIComponent(id)}`;
    const follow = request.kind === "run" || (request.kind === "status" && request.follow === true);
    const initial =
      request.kind === "cancel" ? await send(`${path}/cancel`, "POST") : await send(path);
    let status = executionStatus(initial, id);
    while (follow && (status.state === "queued" || status.state === "running")) {
      if (dependencies.sleep) await dependencies.sleep(2_000, signal);
      else await abortableSleep(2_000, signal, "Follow execution");
      status = executionStatus(await send(path), id);
    }
    showStatus(status, host, request.json ?? false, io);
    return !follow || status.state === "completed" ? 0 : status.state === "cancelled" ? 7 : 6;
  } catch (error) {
    if (pendingKey && !admittedId && uncertain(error))
      io.stderr.write(
        `Admission could not be confirmed. Retry on ${host} with the same command, inputs and --idempotency-key ${pendingKey}.\n`
      );
    if (admittedId) io.stderr.write(`Follow execution ${admittedId} with remote status.\n`);
    if (signal.aborted) {
      io.stderr.write("Stopped waiting locally. Remote work may continue.\n");
      return 7;
    }
    io.stderr.write(`${terminalSafeText(errorMessage(error))}\n`);
    if (error instanceof HostedRequestError && (error.status === 400 || error.status === 413))
      return 4;
    if (error instanceof HostedRequestError && error.status === 409) return 6;
    return 2;
  } finally {
    managed.cleanup();
  }
}
