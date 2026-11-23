import { writeCliChunk, type WorkbenchCliIo } from "../workbench-shared.js";
import { isCloudTransportError, type CloudClient } from "./client.js";
import type { FollowEvent, FollowGap, FollowLog } from "./follow-protocol.js";
import type { cloudOutput } from "./output.js";
import { CloudClientError, type CliRun, type CloudRunStatus } from "./protocol.js";
import type { cloudSleep } from "./shared.js";

function terminalRun(status: CloudRunStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

export function writeCloudLog(
  output: WorkbenchCliIo["stdout"],
  log: Omit<FollowLog, "position">,
  safeText: (value: string) => string,
  signal: AbortSignal
): Promise<void> {
  const time = log.time === undefined ? "" : `${new Date(log.time).toISOString()} `;
  const command = log.command === undefined ? "" : safeText(log.command);
  const label = [command, log.channel].filter(Boolean).join(" ");
  const truncated = log.truncated ? " [truncated]" : "";
  return writeCliChunk(
    output,
    `${time}${log.level}${label ? ` [${label}]` : ""}: ${safeText(log.message)}${truncated}\n`,
    signal
  );
}

export interface ObservationContext {
  client: CloudClient;
  workspace: string;
  io: WorkbenchCliIo;
  signal: AbortSignal;
  json: boolean;
  output: ReturnType<typeof cloudOutput>;
  sleep: typeof cloudSleep;
}

function assertRun(run: CliRun, pipelineId: string, status?: CloudRunStatus): void {
  if (run.pipelineId !== pipelineId || (status !== undefined && run.status !== status))
    throw new CloudClientError("Cloud returned a conflicting run projection.", "invalid_response");
}

export async function pollCloudRun(
  context: ObservationContext,
  runId: string,
  initial?: CliRun
): Promise<CliRun> {
  const { client, workspace, signal, io, json, output, sleep } = context;
  io.stderr.write("Polling retained Cloud status and logs.\n");
  let run = initial ?? (await client.getRun(workspace, runId));
  const pipelineId = run.pipelineId;
  let printed = 0;
  let failures = 0;
  while (true) {
    if (!json) {
      for (const log of run.logs.slice(printed))
        await writeCloudLog(io.stdout, log, output.text, signal);
      printed = Math.max(printed, run.logs.length);
    }
    if (terminalRun(run.status)) return run;
    await sleep(2000 * Math.max(failures, 1), signal);
    try {
      run = await client.getRun(workspace, runId);
      assertRun(run, pipelineId);
      failures = 0;
    } catch (error) {
      if (!isCloudTransportError(error) || ++failures >= 3) throw error;
    }
  }
}

function gapNotice(gap: FollowGap): string {
  switch (gap.reason) {
    case "retention":
      return gap.from === undefined
        ? "Cloud log output is missing from retained history."
        : `Cloud log positions ${gap.from} through ${gap.through} are missing from retained history.`;
    case "source_truncated":
      return "Cloud truncated output at the source.";
    case "output_unavailable":
      return "Cloud command output is unavailable for this run.";
  }
}

export async function streamCloudRun(
  context: ObservationContext,
  runId: string,
  resume: { cursor?: string },
  initial?: CliRun
): Promise<CliRun> {
  const { client, workspace, signal, io, json, output, sleep } = context;
  let projection: Pick<CliRun, "pipelineId" | "status"> | undefined;
  let position = 0;
  let failures = 0;
  const notices = new Set<FollowGap["reason"]>();
  const consume = async (event: FollowEvent, requestSignal: AbortSignal) => {
    let nextPosition = position;
    let nextProjection = projection;
    let notice: FollowGap["reason"] | undefined;
    switch (event.type) {
      case "snapshot":
      case "progress":
      case "terminal": {
        const run = event.payload.run;
        const expectedPipeline = projection?.pipelineId ?? initial?.pipelineId;
        if (expectedPipeline !== undefined && expectedPipeline !== run.pipelineId)
          throw new CloudClientError(
            "Cloud returned a conflicting run pipeline.",
            "invalid_response"
          );
        if (!json && run.status !== projection?.status && !terminalRun(run.status))
          await writeCliChunk(
            io.stdout,
            `Run ${output.text(runId)}: ${run.status}\n`,
            requestSignal
          );
        nextProjection = run;
        break;
      }
      case "log":
        if (event.payload.position <= position) return;
        if (!json) await writeCloudLog(io.stdout, event.payload, output.text, requestSignal);
        nextPosition = event.payload.position;
        break;
      case "gap": {
        const gap = event.payload;
        if (gap.through !== undefined ? gap.through <= position : notices.has(gap.reason)) return;
        const diagnostic = json
          ? JSON.stringify({ type: "cloud_follow_gap", ...gap })
          : gapNotice(gap);
        await writeCliChunk(io.stderr, `${diagnostic}\n`, requestSignal);
        if (gap.through !== undefined) nextPosition = gap.through;
        else notice = gap.reason;
        break;
      }
      case "heartbeat":
      case "end":
        break;
    }
    requestSignal.throwIfAborted();
    position = nextPosition;
    projection = nextProjection;
    if (notice !== undefined) notices.add(notice);
    resume.cursor = event.cursor;
  };
  for (;;) {
    const before = position;
    let sawSnapshot = false;
    const boundary = await client
      .followRun(workspace, runId, resume.cursor, async (event, requestSignal) => {
        await consume(event, requestSignal);
        if (event.type === "snapshot") sawSnapshot = true;
      })
      .catch((error: unknown) => {
        if (!isCloudTransportError(error) || signal.aborted) throw error;
        return error;
      });
    if (boundary instanceof CloudClientError) {
      if (position !== before) failures = 0;
      if (++failures >= 3) throw boundary;
    } else if (boundary.type === "terminal") {
      // A terminal stream projection always omits some retained run fields.
      // Read the complete JSON only after all streamed output has been consumed.
      const run = await client.getRun(workspace, runId);
      assertRun(run, boundary.payload.run.pipelineId, boundary.payload.run.status);
      if (boundary.payload.outcome === "interrupted")
        io.stderr.write(
          json
            ? '{"type":"cloud_follow_terminal","outcome":"interrupted"}\n'
            : "Remote execution was interrupted.\n"
        );
      return run;
    } else {
      const { reason, resumable } = boundary.payload;
      if (!resumable)
        throw new CloudClientError(
          reason === "authorization_lost"
            ? "Cloud observation authority expired or was revoked."
            : "The run is no longer available for observation.",
          reason
        );
      if ((reason === "deadline" && sawSnapshot) || position !== before) failures = 0;
      else if (++failures >= 3)
        throw new CloudClientError(
          "Cloud stopped observation without advancing output.",
          reason === "deadline" ? "timeout" : "observation_unavailable"
        );
    }
    await sleep(250 * 2 ** Math.max(failures - 1, 0), signal);
  }
}
