import type { HostedLaunchResult, HostedLaunchValues } from "../hosting/launch-admission.js";
import { HOSTED_EXECUTIONS_PATH, type HostedExecutionStatus } from "../hosting/execution-status.js";
import { errorResponse, readJsonBody, StudioRequestError } from "../studio/server/http.js";
import { parseStudioLaunchRequest } from "../studio/shared/protocol.js";
import { isJsonObject } from "../utilities/canonical-json.js";
import { jsonResponse } from "../utilities/http-response.js";
import { isLaunchIdentifier } from "../utilities/launch-identifier.js";
import { executionFollowResponse } from "./cloudflare-execution-follow.js";
import { EXECUTION_FOLLOW_CAPABILITY } from "../hosting/execution/follow.js";
import type { ReadExecutionFollowPage } from "../hosting/execution/follow-store.js";

export function isExecutionPath(pathname: string): boolean {
  return pathname === HOSTED_EXECUTIONS_PATH || pathname.startsWith(`${HOSTED_EXECUTIONS_PATH}/`);
}

/** The Worker checks Access before supplying these capabilities. */
export async function serveExecutionRequest(
  request: Request,
  url: URL,
  app: {
    deployment: { projectId: string; deploymentId: string | undefined };
    launch(commandId: string, values: HostedLaunchValues, key: string): Promise<HostedLaunchResult>;
    get(id: string): Promise<HostedExecutionStatus | undefined>;
    cancel(id: string): Promise<HostedExecutionStatus | undefined>;
    readFollowPage: ReadExecutionFollowPage;
  }
): Promise<Response> {
  if (app.deployment.deploymentId === undefined)
    return errorResponse(
      503,
      "execution_api_not_configured",
      "The execution API requires a deploymentId.",
      "Set deploymentId on createCloudflareApp and redeploy."
    );
  if (request.method === "POST") {
    const origin = request.headers.get("origin");
    if (
      (origin !== null && origin !== url.origin) ||
      request.headers.get("x-tubeless-execution") !== "1"
    ) {
      return errorResponse(
        403,
        "execution_guard_required",
        "Execution request was refused.",
        "Send X-Tubeless-Execution: 1. Browser requests must use the same origin."
      );
    }
  }
  const path = url.pathname.slice(HOSTED_EXECUTIONS_PATH.length);
  if (path === "" && request.method === "GET") return jsonResponse(app.deployment);
  if (path === "" && request.method === "POST") {
    if (
      request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !==
      "application/json"
    )
      return errorResponse(
        415,
        "content_type_required",
        "Expected JSON.",
        "Send Content-Type: application/json."
      );
    let raw: unknown;
    try {
      raw = await readJsonBody(request);
    } catch (error) {
      if (error instanceof StudioRequestError)
        return errorResponse(error.status, error.code, error.message, error.hint);
      throw error;
    }
    const valid = parseStudioLaunchRequest(raw);
    const commandId = isJsonObject(raw) ? raw.commandId : undefined;
    if (
      !valid?.idempotencyKey ||
      typeof commandId !== "string" ||
      commandId.length === 0 ||
      commandId.length > 4096
    )
      return errorResponse(
        400,
        "invalid_launch",
        "Expected commandId, values and idempotencyKey.",
        "Send a registered command, supported parameter values, and a stable idempotency key."
      );
    const result = await app.launch(commandId, valid.values, valid.idempotencyKey);
    if (result.accepted) return jsonResponse({ executionId: result.launchId }, 202);
    if (result.code === "idempotency_conflict")
      return jsonResponse(
        { code: result.code, errors: result.errors, executionId: result.launchId },
        409
      );
    return jsonResponse(result, 400);
  }

  const match = /^\/([^/]+)(?:\/(cancel|events))?$/.exec(path);
  // Execution identifiers use only URL-safe characters. The CLI also percent-encodes colons.
  let id: string | undefined;
  if (match) {
    try {
      id = decodeURIComponent(match[1]);
    } catch {
      /* Invalid encoded identifier. */
    }
  }
  if (isLaunchIdentifier(id)) {
    const action = match?.[2];
    const cancel = action === "cancel";
    if (request.method !== (cancel ? "POST" : "GET"))
      return errorResponse(
        405,
        "method_not_allowed",
        "Method not allowed.",
        "Use GET for status or POST to request cancellation."
      );
    if (action === "events") {
      const raw = url.searchParams.get("cursor") ?? "0";
      const cursor = Number(raw);
      if (!/^\d{1,16}$/.test(raw) || !Number.isSafeInteger(cursor))
        return errorResponse(
          400,
          "invalid_cursor",
          "Invalid execution cursor.",
          "Use the last cursor from this execution or omit it to read from the beginning."
        );
      const page = await app.readFollowPage(id, cursor);
      return page
        ? executionFollowResponse(id, cursor, page, app.readFollowPage)
        : executionNotFound();
    }
    const status = await (cancel ? app.cancel(id) : app.get(id));
    if (status) {
      const cancelling = cancel && status.cancellationRequested && status.state === "running";
      return jsonResponse(
        cancel ? status : { ...status, runFollowing: EXECUTION_FOLLOW_CAPABILITY },
        cancelling ? 202 : 200
      );
    }
  }
  return executionNotFound();
}

function executionNotFound(): Response {
  return errorResponse(
    404,
    "execution_not_found",
    "Execution not found.",
    "Use the ID from an admission receipt."
  );
}
