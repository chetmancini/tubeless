import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import {
  formatHttpUrlHost,
  isLiteralOrLocalhostHttpHost,
  isUnspecifiedHttpHost,
  normalizeHttpAuthority,
  parseHttpAuthority,
} from "./run-store-ui-http.js";
import {
  projectPipelineRun,
  type PipelineRunEventReader,
  type PipelineRunEventStore,
} from "../run-store/run-store.js";
import {
  PIPELINE_RUN_STUDIO_HTML,
  PIPELINE_RUN_STUDIO_SCRIPT,
  PIPELINE_RUN_STUDIO_STYLE,
} from "./run-store-ui-page.js";
import {
  isPipelineRunStudioParameter,
  parseStudioLaunchRequest,
  parseStudioPlanInput,
  type PipelineRunStudioLauncher,
} from "./run-store-ui-protocol.js";
import {
  PipelineRunStudioEventState,
  PipelineRunStudioHistoryBusyError,
  type PipelineRunStudioHistoryMaintenance,
} from "./run-store-ui-state.js";

export type {
  PipelineRunStudioCommand,
  PipelineRunStudioLauncher,
  PipelineRunStudioLaunchResult,
} from "./run-store-ui-protocol.js";
export type { PipelineRunStudioHistoryMaintenance } from "./run-store-ui-state.js";

const studioStyleCspHash = `'sha256-${createHash("sha256").update(PIPELINE_RUN_STUDIO_STYLE).digest("base64")}'`;
const studioScriptCspHash = `'sha256-${createHash("sha256").update(PIPELINE_RUN_STUDIO_SCRIPT).digest("base64")}'`;
const studioPageCsp = `default-src 'none'; style-src ${studioStyleCspHash}; script-src ${studioScriptCspHash}; img-src data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;

export interface PipelineRunStudioOptions {
  /** Bind address. Defaults to loopback only. */
  host?: string;
  /** Optional all-history maintenance capability. Omit it to keep history immutable. */
  history?: PipelineRunStudioHistoryMaintenance;
  /** Optional execution capability. Omit it to keep the studio read-only. */
  launcher?: PipelineRunStudioLauncher;
  /** HTTP port. Pass `0` to select an available port. Defaults to `4317`. */
  port?: number;
  store: PipelineRunEventReader | PipelineRunEventStore;
}

export interface PipelineRunStudioServer {
  readonly host: string;
  readonly port: number;
  readonly url: string;
  close(): Promise<void>;
}

function writeJson(
  response: import("node:http").ServerResponse,
  value: unknown,
  status = 200
): void {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(value));
}

function writeError(
  response: import("node:http").ServerResponse,
  status: number,
  code: string,
  message: string,
  hint: string
): void {
  writeJson(response, { code, hint, message }, status);
}

function isAddressInfo(
  address: string | import("node:net").AddressInfo | null
): address is import("node:net").AddressInfo {
  return typeof address !== "string" && address !== null;
}

async function readJsonBody(request: import("node:http").IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let byteLength = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    byteLength += buffer.byteLength;
    if (byteLength > 65_536) {
      throw new StudioRequestError(
        "request_body_too_large",
        "Request body exceeds 64 KiB.",
        413,
        "Send a JSON body no larger than 64 KiB."
      );
    }
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new StudioRequestError(
      "invalid_json",
      "Request body must be valid JSON.",
      400,
      "Send a valid JSON object with content-type application/json."
    );
  }
}

class StudioRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly hint: string
  ) {
    super(message);
  }
}

function decodePathSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new StudioRequestError(
      "malformed_path_segment",
      "Malformed path segment.",
      400,
      "Percent-encode the path segment as valid UTF-8."
    );
  }
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

/** Start the local studio against any store and optional execution capability. */
export async function startPipelineRunStudio(
  options: PipelineRunStudioOptions
): Promise<PipelineRunStudioServer> {
  const host = options.host ?? "127.0.0.1";
  const requestedPort = options.port ?? 4317;
  const history = options.history;
  const launcher = options.launcher;
  const commands = [...(launcher?.commands ?? [])];
  const commandById = new Map(commands.map((command) => [command.id, command] as const));
  const commandIds = new Set<string>();
  for (const command of commands) {
    if (!command.id || !command.name || !Array.isArray(command.parameters)) {
      throw new Error(
        "Studio commands require non-empty id and name values plus parameter metadata."
      );
    }
    if (!command.parameters.every(isPipelineRunStudioParameter)) {
      throw new Error(`Studio command ${JSON.stringify(command.id)} has invalid parameters.`);
    }
    if (commandIds.has(command.id)) {
      throw new Error(`Duplicate studio command id ${JSON.stringify(command.id)}.`);
    }
    commandIds.add(command.id);
  }
  const eventState = new PipelineRunStudioEventState(options.store);
  let expectedAuthority: string | undefined;
  const wildcardBind = isUnspecifiedHttpHost(host);
  const isTrustedAuthority = (request: import("node:http").IncomingMessage): boolean => {
    const requestAuthority = normalizeHttpAuthority(request.headers.host);
    if (!requestAuthority || !expectedAuthority) return false;
    if (requestAuthority === expectedAuthority) return true;
    if (!wildcardBind) return false;
    const requestParts = parseHttpAuthority(requestAuthority);
    const expectedParts = parseHttpAuthority(expectedAuthority);
    return (
      requestParts !== undefined &&
      expectedParts !== undefined &&
      requestParts.port === expectedParts.port &&
      isLiteralOrLocalhostHttpHost(requestParts.hostname)
    );
  };
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://studio.local");
      if (!isTrustedAuthority(request)) {
        writeError(
          response,
          403,
          "untrusted_host",
          "The request host is not trusted.",
          "Use the exact local Studio URL printed by tubeless ui."
        );
        return;
      }
      if (request.method === "GET" && url.pathname === "/") {
        response.writeHead(200, {
          "cache-control": "no-store",
          "content-security-policy": studioPageCsp,
          "content-type": "text/html; charset=utf-8",
          "x-content-type-options": "nosniff",
        });
        response.end(PIPELINE_RUN_STUDIO_HTML);
        return;
      }
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
        writeJson(response, { events, run: projectPipelineRun(events) });
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
        if (!commandIds.has(commandId)) {
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
      console.error(error instanceof Error ? (error.stack ?? error.message) : error);
      writeError(
        response,
        500,
        "studio_internal_error",
        "The studio hit an unexpected error.",
        "Inspect the local Studio process logs and retry after fixing the reported cause."
      );
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(requestedPort, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!isAddressInfo(address)) {
    await closeServer(server);
    throw new Error("The local studio did not receive a TCP address.");
  }
  const port = address.port;
  const urlHost = formatHttpUrlHost(host);
  const authority = `${urlHost}:${port}`;
  expectedAuthority = normalizeHttpAuthority(authority);
  if (!expectedAuthority) {
    await closeServer(server);
    throw new Error("The local studio could not normalize its HTTP authority.");
  }
  return {
    host,
    port,
    url: `http://${authority}`,
    close: () => closeServer(server),
  };
}
