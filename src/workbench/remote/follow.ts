import {
  EXECUTION_FOLLOW_CAPABILITY,
  EXECUTION_FOLLOW_LINE_BYTES,
  EXECUTION_FOLLOW_MEDIA_TYPE,
  EXECUTION_FOLLOW_WINDOW_BYTES,
  executionFollowEventSchema,
  type ExecutionFollowOutput,
} from "../../hosting/execution/follow.js";
import { executionIsActive, type HostedExecutionStatus } from "../../hosting/execution-status.js";
import { abortableSleep } from "../../utilities/abort.js";
import { isJsonObject } from "../../utilities/canonical-json.js";
import { cancelBody, NdjsonFormatError, readNdjson } from "../../utilities/read-body.js";
import { terminalSafeText, writeCliChunk, type WorkbenchCliIo } from "../workbench-shared.js";

class FollowConnectionError extends Error {}

function invalidFollow(cause?: unknown): never {
  throw new Error("The Worker returned an invalid execution event stream.", { cause });
}

function renderOutput(event: ExecutionFollowOutput): string {
  const { runId, pipelineId, parentRunId, stepId, attemptId, message, truncated } = event.payload;
  const label = terminalSafeText(
    [
      stepId === undefined ? pipelineId : `${pipelineId}/${stepId}`,
      `run=${runId}`,
      parentRunId === undefined ? "" : `parent=${parentRunId}`,
      attemptId === undefined ? "" : `attempt=${attemptId}`,
    ]
      .filter(Boolean)
      .join(" ")
  );
  const suffix = truncated ? " [truncated]" : "";
  if (event.type === "log")
    return `${event.payload.level} [${label}]: ${terminalSafeText(event.payload.message)}${suffix}\n`;
  const { completed, total } = event.payload;
  const fraction = total === undefined ? String(completed) : `${completed}/${total}`;
  const detail = message === undefined ? "" : ` ${terminalSafeText(message)}`;
  return `progress [${label}]: ${fraction}${detail}${suffix}\n`;
}

async function* readWindow(
  request: () => Promise<Response>,
  signal: AbortSignal
): AsyncGenerator<unknown> {
  const response = await request().catch((cause: unknown) => {
    throw new FollowConnectionError("Could not connect to the Worker event stream.", { cause });
  });
  if (!response.ok) {
    cancelBody(response.body);
    const message = `Worker returned HTTP ${response.status} during observation.`;
    if (response.status >= 500) throw new FollowConnectionError(message);
    throw new Error(`${message} Check the host and Access policy.`);
  }
  if (
    !response.body ||
    response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !==
      EXECUTION_FOLLOW_MEDIA_TYPE
  ) {
    cancelBody(response.body);
    return invalidFollow();
  }
  try {
    yield* readNdjson(
      response.body,
      signal,
      EXECUTION_FOLLOW_LINE_BYTES,
      EXECUTION_FOLLOW_WINDOW_BYTES
    );
  } catch (cause) {
    if (cause instanceof NdjsonFormatError) return invalidFollow(cause);
    throw new FollowConnectionError("The Worker event stream disconnected.", { cause });
  }
  throw new FollowConnectionError("The Worker event stream ended before settlement.");
}

function decodeEvent(value: unknown) {
  try {
    return executionFollowEventSchema.decode(value, "execution event");
  } catch (cause) {
    return invalidFollow(cause);
  }
}

export async function followWorkerExecution(options: {
  initial: HostedExecutionStatus;
  capability: unknown;
  getStatus(): Promise<HostedExecutionStatus>;
  endpoint: string;
  headers: Headers;
  fetcher: typeof fetch;
  io: WorkbenchCliIo;
  json?: boolean;
  signal: AbortSignal;
  sleep?(ms: number, signal: AbortSignal): Promise<void>;
}): Promise<HostedExecutionStatus> {
  const { initial, capability, getStatus, endpoint, fetcher, io, json, signal } = options;
  const sleep =
    options.sleep ??
    ((ms: number, waitSignal: AbortSignal) => abortableSleep(ms, waitSignal, "Follow execution"));
  if (capability === undefined) {
    // Only a successful status read can select legacy polling.
    let status = initial;
    while (executionIsActive(status)) {
      await sleep(2000, signal);
      status = await getStatus();
    }
    return status;
  }
  if (
    !isJsonObject(capability) ||
    capability.version !== EXECUTION_FOLLOW_CAPABILITY.version ||
    capability.transport !== EXECUTION_FOLLOW_CAPABILITY.transport
  )
    throw new Error("The Worker advertised an unsupported run-following capability.");

  const headers = new Headers(options.headers);
  headers.set("accept", EXECUTION_FOLLOW_MEDIA_TYPE);
  const id = initial.executionId;
  let cursor = 0;
  let failures = 0;
  let gapReported = false;
  let lastActiveStatus: string | undefined;
  for (;;) {
    const before = cursor;
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
    const request = () =>
      fetcher(`${endpoint}/events?cursor=${before}`, {
        headers,
        redirect: "manual",
        signal: requestSignal,
      });
    try {
      let first = true;
      for await (const value of readWindow(request, requestSignal)) {
        const event = decodeEvent(value);
        const { type, payload } = event;
        if (event.executionId !== id || first !== (type === "snapshot")) return invalidFollow();
        first = false;
        if (type === "log" || type === "progress") {
          if (event.cursor <= cursor) continue;
          if (!json) await writeCliChunk(io.stdout, renderOutput(event), signal);
          cursor = event.cursor;
          continue;
        }
        if (event.cursor !== cursor) return invalidFollow();
        if (type === "end") break;
        if (type === "heartbeat") continue;
        if (type === "gap") {
          if (!gapReported)
            await writeCliChunk(io.stderr, "Some execution history is unavailable.\n", signal);
          gapReported = true;
          continue;
        }
        if (payload.executionId !== id || payload.commandId !== initial.commandId)
          return invalidFollow();
        if (type === "terminal") {
          if (executionIsActive(payload)) return invalidFollow();
          return payload;
        }
        if (!json && executionIsActive(payload)) {
          const { state, target, reason } = payload;
          const summary = `${state}${target ? ` on ${target}` : ""}${reason ? ` (${reason})` : ""}`;
          if (summary !== lastActiveStatus)
            await writeCliChunk(io.stdout, `Execution ${id}: ${summary}\n`, signal);
          lastActiveStatus = summary;
        }
      }
      failures = 0;
    } catch (error) {
      if (!(error instanceof FollowConnectionError) || signal.aborted) throw error;
      failures = cursor > before ? 1 : failures + 1;
      if (failures >= 3) throw error;
    }
    await sleep(250 * 2 ** Math.max(failures - 1, 0), signal);
  }
}
