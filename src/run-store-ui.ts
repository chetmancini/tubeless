import { createServer, type Server } from "node:http";
import { formatHttpUrlHost, normalizeHttpAuthority } from "./run-store-ui-http.js";
import { projectPipelineRun, type PipelineRunEventStore } from "./run-store.js";
import { PIPELINE_RUN_STUDIO_HTML } from "./run-store-ui-page.js";
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
  PipelineRunStudioCancelResult,
  PipelineRunStudioCommand,
  PipelineRunStudioLauncher,
  PipelineRunStudioLaunchResult,
  PipelineRunStudioLaunchRequest,
} from "./run-store-ui-protocol.js";
export type { PipelineRunStudioHistoryMaintenance } from "./run-store-ui-state.js";

export interface PipelineRunStudioOptions {
  /** Bind address. Defaults to loopback only. */
  host?: string;
  /** Optional all-history maintenance capability. Omit it to keep history immutable. */
  history?: PipelineRunStudioHistoryMaintenance;
  /** Optional execution capability. Omit it to keep the studio read-only. */
  launcher?: PipelineRunStudioLauncher;
  /** HTTP port. Pass `0` to select an available port. Defaults to `4317`. */
  port?: number;
  store: PipelineRunEventStore;
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
    if (byteLength > 65_536) throw new StudioRequestError("Request body exceeds 64 KiB.", 413);
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new StudioRequestError("Request body must be valid JSON.", 400);
  }
}

class StudioRequestError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
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
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://studio.local");
      if (request.method === "GET" && url.pathname === "/") {
        response.writeHead(200, {
          "cache-control": "no-store",
          "content-security-policy":
            "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; connect-src 'self'",
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
        const runId = decodeURIComponent(runMatch[1]!);
        const events = await eventState.readRun(runId);
        if (events.length === 0) {
          writeJson(response, { error: "Run not found." }, 404);
          return;
        }
        writeJson(response, { events, run: projectPipelineRun(events) });
        return;
      }
      const cancelMatch = /^\/api\/runs\/([^/]+)\/cancel$/.exec(url.pathname);
      if (request.method === "POST" && cancelMatch) {
        if (!launcher?.cancel) {
          writeJson(response, { error: "Pipeline cancellation is not enabled." }, 405);
          return;
        }
        if (normalizeHttpAuthority(request.headers.host) !== expectedAuthority) {
          writeJson(response, { error: "The cancel request host is not trusted." }, 403);
          return;
        }
        if (request.headers["x-tubeless-studio-cancel"] !== "1") {
          writeJson(response, { error: "A same-origin cancel request is required." }, 415);
          return;
        }
        const runId = decodeURIComponent(cancelMatch[1]!);
        const result = await launcher.cancel(runId);
        if (!result.cancelled) {
          writeJson(response, { error: "The run is not a live launch." }, 404);
          return;
        }
        writeJson(response, { cancelled: true, runId: result.runId }, 202);
        return;
      }
      if (request.method === "DELETE" && url.pathname === "/api/history") {
        if (!history) {
          writeJson(response, { error: "History maintenance is not enabled." }, 405);
          return;
        }
        if (normalizeHttpAuthority(request.headers.host) !== expectedAuthority) {
          writeJson(response, { error: "The history request host is not trusted." }, 403);
          return;
        }
        if (request.headers["x-tubeless-studio-clear-history"] !== "1") {
          writeJson(response, { error: "A same-origin history request is required." }, 415);
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
        const commandId = decodeURIComponent(planMatch[1]!);
        if (!launcher?.plan || !commandById.get(commandId)?.canPlan) {
          writeJson(response, { error: "Pipeline planning is not enabled." }, 405);
          return;
        }
        if (normalizeHttpAuthority(request.headers.host) !== expectedAuthority) {
          writeJson(response, { error: "The plan request host is not trusted." }, 403);
          return;
        }
        if (
          !request.headers["content-type"]?.startsWith("application/json") ||
          request.headers["x-tubeless-studio-plan"] !== "1"
        ) {
          writeJson(response, { error: "A same-origin JSON plan request is required." }, 415);
          return;
        }
        const input = parseStudioPlanInput(await readJsonBody(request));
        if (!input) {
          writeJson(response, { error: "Plan input must contain bounded selections." }, 400);
          return;
        }
        writeJson(response, { plan: await launcher.plan(commandId, input) });
        return;
      }
      const launchMatch = /^\/api\/commands\/([^/]+)\/runs$/.exec(url.pathname);
      if (request.method === "POST" && launchMatch) {
        if (!launcher) {
          writeJson(response, { error: "Pipeline launching is not enabled." }, 405);
          return;
        }
        if (normalizeHttpAuthority(request.headers.host) !== expectedAuthority) {
          writeJson(response, { error: "The launch request host is not trusted." }, 403);
          return;
        }
        if (
          !request.headers["content-type"]?.startsWith("application/json") ||
          request.headers["x-tubeless-studio-launch"] !== "1"
        ) {
          writeJson(response, { error: "A same-origin JSON launch request is required." }, 415);
          return;
        }
        const launch = parseStudioLaunchRequest(await readJsonBody(request));
        if (!launch) {
          writeJson(
            response,
            { error: "values must contain at most 128 bounded JSON-safe entries." },
            400
          );
          return;
        }
        const commandId = decodeURIComponent(launchMatch[1]!);
        if (!commandIds.has(commandId)) {
          writeJson(response, { error: "Pipeline command not found." }, 404);
          return;
        }
        const result = await launcher.launch(commandId, launch.values);
        writeJson(response, result, result.accepted ? 202 : 400);
        return;
      }
      if (request.method !== "GET") {
        writeJson(response, { error: "Method not allowed." }, 405);
        return;
      }
      writeJson(response, { error: "Not found." }, 404);
    } catch (error) {
      writeJson(
        response,
        { error: error instanceof Error ? error.message : String(error) },
        error instanceof StudioRequestError
          ? error.status
          : error instanceof PipelineRunStudioHistoryBusyError
            ? 409
            : 500
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
