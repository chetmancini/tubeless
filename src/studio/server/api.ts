import type { PipelineRunEventReader } from "../../run-store/run-store.js";
import type { LaunchActor, StudioLaunchMetadata } from "../shared/launch-metadata.js";
import { jsonResponse } from "../../utilities/http-response.js";
import { sha256Hex } from "../../utilities/sha256.js";
import type { AgentTranscriptReader } from "../../tracing/agent-transcript.js";
import {
  parseStudioResourcePath,
  STUDIO_API_ACTION,
  STUDIO_API_PATH,
  STUDIO_GUARD_HEADER,
  STUDIO_GUARD_VALUE,
} from "../shared/api-paths.js";
import {
  isPipelineRunStudioParameter,
  parseStudioLaunchRequest,
  parseStudioPlanInput,
  type PipelineRunStudioCommand,
  type PipelineRunStudioLauncher,
} from "../shared/protocol.js";
import {
  PipelineRunStudioEventState,
  PipelineRunStudioHistoryBusyError,
  type PipelineRunStudioHistoryMaintenance,
} from "./state.js";
import {
  errorResponse,
  readJsonBody,
  decodePathSegment,
  StudioRequestError,
  unexpectedStudioErrorResponse,
} from "./http.js";

export interface PipelineRunStudioApiOptions {
  /** Optional all-history maintenance capability. Omit it to keep history immutable. */
  history?: PipelineRunStudioHistoryMaintenance;
  launchMetadata?: { forRun(runId: string): Promise<StudioLaunchMetadata | undefined> };
  /** Optional execution capability. Omit it to keep the studio read-only. */
  launcher?: PipelineRunStudioLauncher;
  store: Pick<PipelineRunEventReader, "listEvents" | "transcripts">;
  /** Explicit transcript source, behind the same authentication and run scope as history. */
  transcripts?: Pick<AgentTranscriptReader, "list">;
}

export function createStudioApiHandler(
  options: PipelineRunStudioApiOptions
): (request: Request, url: URL, actor?: LaunchActor) => Promise<Response> {
  // An attached artifact is read-only; never advertise deletion that would leave its content behind.
  const history = options.transcripts ? undefined : options.history;
  const transcripts = options.transcripts ?? options.store.transcripts;
  const transcriptLive = Boolean(transcripts && !options.transcripts);
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
  const instanceId = crypto.randomUUID();
  return async (request, url, actor) => {
    try {
      if (request.method === "GET" && url.pathname === STUDIO_API_PATH.snapshot) {
        const query = url.searchParams.get("query") ?? "";
        if (query.length > 4096)
          throw new StudioRequestError(
            "invalid_query",
            "Search is too long.",
            400,
            "Use at most 4096 characters."
          );
        const pipelineId = url.searchParams.get("pipeline") ?? "";
        if (pipelineId.length > 4096)
          throw new StudioRequestError(
            "invalid_pipeline",
            "Pipeline ID is too long.",
            400,
            "Use at most 4096 characters."
          );
        const snapshot = await eventState.workspace(
          query,
          historyOffset(url),
          url.searchParams.get("run"),
          pipelineId
        );
        const liveRunIds = (await launcher?.liveRunIds?.()) ?? [];
        const etag = `"${await sha256Hex(new TextEncoder().encode(JSON.stringify([instanceId, snapshot.revision, url.search, liveRunIds])))}"`;
        if (request.headers.get("if-none-match") === etag) {
          return new Response(null, { status: 304, headers: { etag } });
        }
        return jsonResponse({ ...snapshot, liveRunIds }, 200, { etag });
      }
      if (
        request.method === "GET" &&
        (url.pathname === STUDIO_API_PATH.definitions ||
          url.pathname === STUDIO_API_PATH.definitionRuns)
      ) {
        const pipelineId = url.searchParams.get("pipelineId") ?? "";
        const definitionId = url.searchParams.get("definitionId") ?? undefined;
        const result =
          url.pathname === STUDIO_API_PATH.definitionRuns
            ? await eventState.definitionRuns(pipelineId, definitionId, historyOffset(url))
            : await eventState
                .definition(pipelineId, definitionId)
                .then((definition) => definition && { definition });
        return result
          ? jsonResponse(result)
          : errorResponse(
              404,
              "definition_not_found",
              "Definition not found.",
              "Refresh the observed definitions."
            );
      }
      if (request.method === "GET" && url.pathname === STUDIO_API_PATH.capabilities) {
        return jsonResponse({
          canCancel: launcher?.cancel !== undefined && launcher.liveRunIds !== undefined,
          canClearHistory: history !== undefined,
        });
      }
      const runResource = parseStudioResourcePath(url.pathname, STUDIO_API_PATH.runs);
      if (request.method === "GET" && runResource?.action === STUDIO_API_ACTION.children) {
        const runId = decodePathSegment(runResource.encodedId);
        const page = await eventState.childRuns(runId, childPage(url));
        return page
          ? jsonResponse(page)
          : errorResponse(
              404,
              "run_not_found",
              "Run not found.",
              `Refresh ${STUDIO_API_PATH.snapshot} and choose an available runId.`
            );
      }
      if (request.method === "GET" && runResource && runResource.action === undefined) {
        const runId = decodePathSegment(runResource.encodedId);
        const detail = await eventState.detail(runId);
        return detail
          ? jsonResponse({
              ...detail,
              ...(options.launchMetadata
                ? { launch: (await options.launchMetadata.forRun(runId)) ?? null }
                : {}),
              ...(transcripts
                ? {
                    transcriptAvailable:
                      (transcriptLive && detail.run.agent !== undefined) ||
                      (await transcripts.list({ runId, limit: 1 })).records.length > 0,
                  }
                : {}),
            })
          : errorResponse(
              404,
              "run_not_found",
              "Run not found.",
              `Refresh ${STUDIO_API_PATH.snapshot} and choose an available runId.`
            );
      }
      if (request.method === "GET" && runResource?.action === STUDIO_API_ACTION.transcript) {
        const runId = decodePathSegment(runResource.encodedId);
        const afterSequence = queryInteger(
          url,
          "afterSequence",
          "invalid_cursor",
          "Invalid transcript cursor."
        );
        const result =
          transcripts && (await eventState.transcript(runId, afterSequence, transcripts));
        return result
          ? jsonResponse({ ...result, sourceId: instanceId, live: transcriptLive })
          : errorResponse(
              404,
              "transcript_not_found",
              "Transcript not available for this run.",
              "Choose a recorded agent run with a transcript source."
            );
      }
      if (request.method === "POST" && runResource?.action === STUDIO_API_ACTION.cancel) {
        if (!launcher?.cancel) {
          return errorResponse(
            405,
            "cancellation_not_enabled",
            "Pipeline cancellation is not enabled.",
            "Start the Studio with a launcher that provides cancel and liveRunIds."
          );
        }
        if (request.headers.get(STUDIO_GUARD_HEADER.cancel) !== STUDIO_GUARD_VALUE) {
          return errorResponse(
            415,
            "cancel_guard_required",
            "A same-origin cancel request is required.",
            `Send ${STUDIO_GUARD_HEADER.cancel}: ${STUDIO_GUARD_VALUE} from the Studio origin.`
          );
        }
        const runId = decodePathSegment(runResource.encodedId);
        const result = await launcher.cancel(runId);
        if (!result.cancelled) {
          return errorResponse(
            404,
            "run_not_live",
            "The run is not a live launch.",
            `Refresh ${STUDIO_API_PATH.snapshot} and cancel a run listed in liveRunIds.`
          );
        }
        return jsonResponse({ cancelled: true, runId: result.runId }, 202);
      }
      if (request.method === "DELETE" && url.pathname === STUDIO_API_PATH.history) {
        if (!history) {
          return errorResponse(
            405,
            "history_maintenance_not_enabled",
            "History maintenance is not enabled.",
            "Start the Studio with a history maintenance adapter."
          );
        }
        if (request.headers.get(STUDIO_GUARD_HEADER.clear) !== STUDIO_GUARD_VALUE) {
          return errorResponse(
            415,
            "history_guard_required",
            "A same-origin history request is required.",
            `Send ${STUDIO_GUARD_HEADER.clear}: ${STUDIO_GUARD_VALUE} from the Studio origin.`
          );
        }
        const cleared = await eventState.clear(history);
        return jsonResponse({ cleared: true, ...cleared });
      }
      if (request.method === "GET" && url.pathname === STUDIO_API_PATH.commands) {
        return jsonResponse({ commands });
      }
      const commandResource = parseStudioResourcePath(url.pathname, STUDIO_API_PATH.commands);
      if (request.method === "POST" && commandResource?.action === STUDIO_API_ACTION.plan) {
        const commandId = decodePathSegment(commandResource.encodedId);
        if (!launcher?.plan || !commandById.get(commandId)?.canPlan) {
          return errorResponse(
            405,
            "planning_not_enabled",
            "Pipeline planning is not enabled.",
            "Choose a command with canPlan or start the Studio with a planning launcher."
          );
        }
        if (
          !request.headers.get("content-type")?.startsWith("application/json") ||
          request.headers.get(STUDIO_GUARD_HEADER.plan) !== STUDIO_GUARD_VALUE
        ) {
          return errorResponse(
            415,
            "plan_guard_required",
            "A same-origin JSON plan request is required.",
            `Send application/json with ${STUDIO_GUARD_HEADER.plan}: ${STUDIO_GUARD_VALUE} from the Studio origin.`
          );
        }
        const input = parseStudioPlanInput(await readJsonBody(request));
        if (!input) {
          return errorResponse(
            400,
            "invalid_plan_input",
            "Plan input must contain bounded selections.",
            "Send optional dryRun, stepIds, or targets fields within the documented limits."
          );
        }
        return jsonResponse({ plan: await launcher.plan(commandId, input) });
      }
      if (request.method === "POST" && commandResource?.action === STUDIO_API_ACTION.launch) {
        if (!launcher) {
          return errorResponse(
            405,
            "launching_not_enabled",
            "Pipeline launching is not enabled.",
            "Start the Studio with an execution launcher."
          );
        }
        if (
          !request.headers.get("content-type")?.startsWith("application/json") ||
          request.headers.get(STUDIO_GUARD_HEADER.launch) !== STUDIO_GUARD_VALUE
        ) {
          return errorResponse(
            415,
            "launch_guard_required",
            "A same-origin JSON launch request is required.",
            `Send application/json with ${STUDIO_GUARD_HEADER.launch}: ${STUDIO_GUARD_VALUE} from the Studio origin.`
          );
        }
        const launch = parseStudioLaunchRequest(await readJsonBody(request));
        if (!launch) {
          return errorResponse(
            400,
            "invalid_launch_input",
            "values must contain at most 128 bounded JSON-safe entries.",
            "Send a values object matching the selected command descriptor."
          );
        }
        const commandId = decodePathSegment(commandResource.encodedId);
        if (!commandById.has(commandId)) {
          return errorResponse(
            404,
            "command_not_found",
            "Pipeline command not found.",
            `Refresh ${STUDIO_API_PATH.commands} and choose an available commandId.`
          );
        }
        const result = await launcher.launch(commandId, launch.values, {
          actor,
          idempotencyKey: launch.idempotencyKey,
        });
        if (result.accepted) return jsonResponse(result, 202);
        return jsonResponse(
          {
            ...result,
            code: "launch_rejected",
            hint: "Review errors and retry only after resolving the reported cause.",
            message: "Pipeline launch was rejected.",
          },
          400
        );
      }
      if (request.method !== "GET") {
        return errorResponse(
          405,
          "method_not_allowed",
          "Method not allowed.",
          "Read the Studio guide at https://tubeless.io/docs/studio."
        );
      }
      return errorResponse(
        404,
        "endpoint_not_found",
        "Not found.",
        "Read the Studio guide at https://tubeless.io/docs/studio and choose a supported endpoint."
      );
    } catch (error) {
      if (error instanceof StudioRequestError) {
        return errorResponse(error.status, error.code, error.message, error.hint);
      }
      if (error instanceof PipelineRunStudioHistoryBusyError) {
        return errorResponse(
          409,
          "history_busy",
          error.message,
          "Wait for live runs to finish, then retry the clear request."
        );
      }
      return unexpectedStudioErrorResponse(error);
    }
  };
}

function historyOffset(url: URL): number {
  return queryInteger(url, "offset", "invalid_offset", "Invalid history offset.");
}

function childPage(url: URL): number {
  return queryInteger(url, "page", "invalid_page", "Invalid child page.");
}

function queryInteger(url: URL, name: string, code: string, message: string): number {
  const value = url.searchParams.get(name) ?? "0";
  const parsed = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed))
    throw new StudioRequestError(code, message, 400, "Use a nonnegative safe integer.");
  return parsed;
}
