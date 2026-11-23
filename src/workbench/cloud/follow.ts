import { writeCliChunk, type WorkbenchCliIo } from "../workbench-shared.js";
import { isCloudTransportError, type CloudClient } from "./client.js";
import type { FollowEvent, FollowGap } from "./follow-protocol.js";
import { CloudClientError, type CliRun, type CloudRunStatus } from "./protocol.js";
import type { cloudSleep } from "./shared.js";

function terminalRun(status: CloudRunStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

export function writeCloudLog(
  output: WorkbenchCliIo["stdout"],
  log: Extract<FollowEvent, { type: "log" }>["payload"] | CliRun["logs"][number],
  safeText: (value: string) => string,
  signal: AbortSignal
): Promise<void> {
  const time = log.time === undefined ? "" : `${new Date(log.time).toISOString()} `;
  const command = "command" in log && log.command !== undefined ? safeText(log.command) : "";
  const channel = "channel" in log ? log.channel : undefined;
  const label = [command, channel].filter(Boolean).join(" ");
  const truncated = "truncated" in log && log.truncated ? " [truncated]" : "";
  return writeCliChunk(
    output,
    `${time}${log.level}${label ? ` [${label}]` : ""}: ${safeText(log.message)}${truncated}\n`,
    signal
  );
}

interface Observation {
  client: CloudClient;
  workspace: string;
  runId: string;
  initial?: CliRun;
  io: WorkbenchCliIo;
  signal: AbortSignal;
  json: boolean;
  safeText(value: string): string;
  sleep: typeof cloudSleep;
}

function assertRun(run: CliRun, pipelineId?: string, status?: CloudRunStatus): void {
  if (
    (pipelineId !== undefined && run.pipelineId !== pipelineId) ||
    (status !== undefined && run.status !== status)
  )
    throw new CloudClientError("Cloud returned a conflicting run projection.", "invalid_response");
}

export async function pollCloudRun(observation: Observation): Promise<CliRun> {
  const { client, workspace, runId, initial, signal, io, json, safeText, sleep } = observation;
  io.stderr.write("Polling retained Cloud status and logs.\n");
  let run = initial ?? (await client.getRun(workspace, runId));
  const pipelineId = run.pipelineId;
  let printed = 0;
  let failures = 0;
  while (true) {
    if (!json) {
      for (const log of run.logs.slice(printed))
        await writeCloudLog(io.stdout, log, safeText, signal);
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
  observation: Observation,
  resume: { cursor?: string }
): Promise<CliRun> {
  const { client, workspace, runId, initial, signal, io, json, safeText, sleep } = observation;
  let pipelineId = initial?.pipelineId;
  let status: CloudRunStatus | undefined;
  let position = 0;
  let failures = 0;
  const notices = new Set<FollowGap["reason"]>();
  const consume = async (event: FollowEvent, requestSignal: AbortSignal) => {
    switch (event.type) {
      case "snapshot":
      case "progress":
      case "terminal": {
        const run = event.payload.run;
        if (pipelineId !== undefined && pipelineId !== run.pipelineId)
          throw new CloudClientError(
            "Cloud returned a conflicting run pipeline.",
            "invalid_response"
          );
        pipelineId = run.pipelineId;
        if (!json && run.status !== status && !terminalRun(run.status))
          await writeCliChunk(io.stdout, `Run ${safeText(runId)}: ${run.status}\n`, requestSignal);
        status = run.status;
        break;
      }
      case "log":
        if (event.payload.position <= position) return;
        if (!json) await writeCloudLog(io.stdout, event.payload, safeText, requestSignal);
        position = event.payload.position;
        break;
      case "gap": {
        const gap = event.payload;
        if (gap.through !== undefined ? gap.through <= position : notices.has(gap.reason)) return;
        const diagnostic = json
          ? JSON.stringify({ type: "cloud_follow_gap", ...gap })
          : gapNotice(gap);
        await writeCliChunk(io.stderr, `${diagnostic}\n`, requestSignal);
        if (gap.through !== undefined) position = gap.through;
        else notices.add(gap.reason);
        break;
      }
      case "heartbeat":
      case "end":
        break;
    }
    requestSignal.throwIfAborted();
    resume.cursor = event.cursor;
  };
  for (;;) {
    const before = position;
    let boundary: Awaited<ReturnType<CloudClient["followRun"]>>;
    try {
      boundary = await client.followRun(
        workspace,
        runId,
        resume.cursor,
        async (event, requestSignal) => {
          try {
            await consume(event, requestSignal);
          } catch (error) {
            if (error instanceof CloudClientError || requestSignal.aborted) throw error;
            throw new CloudClientError(
              "Could not write Cloud observation output.",
              "observation_output_error"
            );
          }
        }
      );
    } catch (error) {
      if (!isCloudTransportError(error) || signal.aborted) throw error;
      if (position !== before) failures = 0;
      if (++failures >= 3) throw error;
      await sleep(250 * 2 ** (failures - 1), signal);
      continue;
    }
    if (boundary.type === "terminal") {
      // A terminal stream projection always omits some retained run fields.
      // Read the complete JSON only after all streamed output has been consumed.
      const run = await client.getRun(workspace, runId);
      assertRun(run, pipelineId, boundary.payload.run.status);
      if (boundary.payload.outcome === "interrupted")
        io.stderr.write(
          json
            ? '{"type":"cloud_follow_terminal","outcome":"interrupted"}\n'
            : "Remote execution was interrupted.\n"
        );
      return run;
    }
    const { reason, resumable } = boundary.payload;
    if (!resumable)
      throw new CloudClientError(
        reason === "authorization_lost"
          ? "Cloud observation authority expired or was revoked."
          : "The run is no longer available for observation.",
        reason
      );
    if (reason === "deadline" || position !== before) failures = 0;
    else if (++failures >= 3)
      throw new CloudClientError(
        "Cloud stopped observation without advancing output.",
        "observation_unavailable"
      );
    await sleep(250 * 2 ** Math.max(failures - 1, 0), signal);
  }
}
