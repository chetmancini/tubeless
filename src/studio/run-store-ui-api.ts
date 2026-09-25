import type { IncomingMessage, ServerResponse } from "node:http";
import { projectPipelineRun, type PipelineRunEventReader } from "../run-store/run-store.js";
import {
  isPipelineRunStudioParameter,
  parseStudioLaunchRequest,
  parseStudioPlanInput,
  type PipelineRunStudioCommand,
  type PipelineRunStudioLauncher,
} from "./run-store-ui-protocol.js";
import {
  PipelineRunStudioEventState,
  PipelineRunStudioHistoryBusyError,
  type PipelineRunStudioHistoryMaintenance,
} from "./run-store-ui-state.js";
import {
  writeJson,
  writeError,
  readJsonBody,
  decodePathSegment,
  StudioRequestError,
  writeUnexpectedStudioError,
} from "./run-store-ui-http.js";

export interface PipelineRunStudioApiOptions {
  /** Optional all-history maintenance capability. Omit it to keep history immutable. */
  history?: PipelineRunStudioHistoryMaintenance;
  /** Optional execution capability. Omit it to keep the studio read-only. */
  launcher?: PipelineRunStudioLauncher;
  store: Pick<PipelineRunEventReader, "listEvents">;
}

/** Own API routes and their state without opening a listener or concrete storage. */
export function createStudioApiHandler(
  options: PipelineRunStudioApiOptions
): (request: IncomingMessage, response: ServerResponse, url: URL) => Promise<void> {
  const history = options.history;
  const launcher = options.launcher;
  const commands = [...(launcher?.commands ?? [])];
  const commandById = new Map<string, PipelineRunStudioCommand>();
  for (const command of commands) {
    if (!command.id || !command.name || !Array.isArray(command.parameters)) {
      throw new Error(
        "Studio commands require non-empty id and name values plus parameter metadata."
      );
    }
    if (!command.parameters.every(isPipelineRunStudioParameter)) {
      throw new Error(`Studio command ${JSON.stringify(command.id)} has invalid parameters.`);
    }
    if (commandById.has(command.id)) {
      throw new Error(`Duplicate studio command id ${JSON.stringify(command.id)}.`);
    }
    commandById.set(command.id, command);
  }
  const eventState = new PipelineRunStudioEventState(options.store);
  return async (request, response, url) => {
    try {
      if (request.method === "GET" && url.pathname === "/api/snapshot") {
        const snapshot = await eventState.snapshot();
        writeJson(response, {
          ...snapshot,
          liveRunIds: launcher?.liveRunIds?.() ?? [],
          runs: snapshot.runs.map((run) => ({ ...run, logs: [] })),
        });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/capabilities") {
        writeJson(response, {
          canCancel: launcher?.cancel !== undefined && launcher.liveRunIds !== undefined,
          canClearHistory: history !== undefined,
        });
        return;
      }
      const runMatch = /^\/api\/runs\/([^/]+)$/.exec(url.pathname);
      if (request.method === "GET" && runMatch) {
        const runId = decodePathSegment(runMatch[1]!);
        const events = await eventState.readRun(runId);
        if (events.length === 0) {
          writeError(
            response,
            404,
            "run_not_found",
            "Run not found.",
            "Refresh /api/snapshot and choose an available runId."
          );
          return;
        }
        writeJson(response, { run: projectPipelineRun(events) });
        return;
      }
      const cancelMatch = /^\/api\/runs\/([^/]+)\/cancel$/.exec(url.pathname);
      if (request.method === "POST" && cancelMatch) {
        if (!launcher?.cancel) {
          writeError(
            response,
            405,
            "cancellation_not_enabled",
            "Pipeline cancellation is not enabled.",
            "Start the Studio with a launcher that provides cancel and liveRunIds."
          );
          return;
        }
        if (request.headers["x-tubeless-studio-cancel"] !== "1") {
          writeError(
            response,
            415,
            "cancel_guard_required",
            "A same-origin cancel request is required.",
            "Send x-tubeless-studio-cancel: 1 from the Studio origin."
          );
          return;
        }
        const runId = decodePathSegment(cancelMatch[1]!);
        const result = await launcher.cancel(runId);
        if (!result.cancelled) {
          writeError(
            response,
            404,
            "run_not_live",
            "The run is not a live launch.",
            "Refresh /api/snapshot and cancel a run listed in liveRunIds."
          );
          return;
        }
        writeJson(response, { cancelled: true, runId: result.runId }, 202);
        return;
      }
      if (request.method === "DELETE" && url.pathname === "/api/history") {
        if (!history) {
          writeError(
            response,
            405,
            "history_maintenance_not_enabled",
            "History maintenance is not enabled.",
            "Start the Studio with a history maintenance adapter."
          );
          return;
        }
        if (request.headers["x-tubeless-studio-clear-history"] !== "1") {
          writeError(
            response,
            415,
            "history_guard_required",
            "A same-origin history request is required.",
            "Send x-tubeless-studio-clear-history: 1 from the Studio origin."
          );
          return;
        }
        const cleared = await eventState.clear(history);
        writeJson(response, { cleared: true, ...cleared });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/commands") {
        writeJson(response, { commands });
        return;
      }
      const planMatch = /^\/api\/commands\/([^/]+)\/plan$/.exec(url.pathname);
      if (request.method === "POST" && planMatch) {
        const commandId = decodePathSegment(planMatch[1]!);
        if (!launcher?.plan || !commandById.get(commandId)?.canPlan) {
          writeError(
            response,
            405,
            "planning_not_enabled",
            "Pipeline planning is not enabled.",
            "Choose a command with canPlan or start the Studio with a planning launcher."
          );
          return;
        }
        if (
          !request.headers["content-type"]?.startsWith("application/json") ||
          request.headers["x-tubeless-studio-plan"] !== "1"
        ) {
          writeError(
            response,
            415,
            "plan_guard_required",
            "A same-origin JSON plan request is required.",
            "Send application/json with x-tubeless-studio-plan: 1 from the Studio origin."
          );
          return;
        }
        const input = parseStudioPlanInput(await readJsonBody(request));
        if (!input) {
          writeError(
            response,
            400,
            "invalid_plan_input",
            "Plan input must contain bounded selections.",
            "Send optional dryRun, stepIds, or targets fields within the documented limits."
          );
          return;
        }
        writeJson(response, { plan: await launcher.plan(commandId, input) });
        return;
      }
      const launchMatch = /^\/api\/commands\/([^/]+)\/runs$/.exec(url.pathname);
      if (request.method === "POST" && launchMatch) {
        if (!launcher) {
          writeError(
            response,
            405,
            "launching_not_enabled",
            "Pipeline launching is not enabled.",
            "Start the Studio with an execution launcher."
          );
          return;
        }
        if (
          !request.headers["content-type"]?.startsWith("application/json") ||
          request.headers["x-tubeless-studio-launch"] !== "1"
        ) {
          writeError(
            response,
            415,
            "launch_guard_required",
            "A same-origin JSON launch request is required.",
            "Send application/json with x-tubeless-studio-launch: 1 from the Studio origin."
          );
          return;
        }
        const launch = parseStudioLaunchRequest(await readJsonBody(request));
        if (!launch) {
          writeError(
            response,
            400,
            "invalid_launch_input",
            "values must contain at most 128 bounded JSON-safe entries.",
            "Send a values object matching the selected command descriptor."
          );
          return;
        }
        const commandId = decodePathSegment(launchMatch[1]!);
        if (!commandById.has(commandId)) {
          writeError(
            response,
            404,
            "command_not_found",
            "Pipeline command not found.",
            "Refresh /api/commands and choose an available commandId."
          );
          return;
        }
        const result = await launcher.launch(commandId, launch.values);
        if (result.accepted) {
          writeJson(response, result, 202);
        } else {
          writeJson(
            response,
            {
              ...result,
              code: "launch_rejected",
              hint: "Review errors and retry only after resolving the reported cause.",
              message: "Pipeline launch was rejected.",
            },
            400
          );
        }
        return;
      }
      if (request.method !== "GET") {
        writeError(
          response,
          405,
          "method_not_allowed",
          "Method not allowed.",
          "Read the Studio guide at https://tubeless.io/docs/studio."
        );
        return;
      }
      writeError(
        response,
        404,
        "endpoint_not_found",
        "Not found.",
        "Read the Studio guide at https://tubeless.io/docs/studio and choose a supported endpoint."
      );
    } catch (error) {
      if (error instanceof StudioRequestError) {
        writeError(response, error.status, error.code, error.message, error.hint);
        return;
      }
      if (error instanceof PipelineRunStudioHistoryBusyError) {
        writeError(
          response,
          409,
          "history_busy",
          error.message,
          "Wait for live runs to finish, then retry the clear request."
        );
        return;
      }
      writeUnexpectedStudioError(response, error);
    }
  };
}
