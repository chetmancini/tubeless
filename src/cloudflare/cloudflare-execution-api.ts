import type { HostedLaunchResult, HostedLaunchValues } from "../hosting/launch-admission.js";
import {
  HOSTED_EXECUTIONS_PATH,
  isLaunchIdentifier,
  type HostedExecutionStatus,
} from "../hosting/execution-status.js";
import { errorResponse, readJsonBody, StudioRequestError } from "../studio/server/http.js";
import { parseStudioLaunchRequest } from "../studio/shared/protocol.js";
import { isJsonObject } from "../utilities/canonical-json.js";
import { jsonResponse } from "../utilities/http-response.js";

export function isExecutionPath(pathname: string): boolean {
  return pathname === HOSTED_EXECUTIONS_PATH || pathname.startsWith(`${HOSTED_EXECUTIONS_PATH}/`);
}

/** The Worker checks Access before supplying these capabilities. */
export async function serveExecutionRequest(
  request: Request,
  url: URL,
  app: {
    launch(commandId: string, values: HostedLaunchValues, key: string): Promise<HostedLaunchResult>;
    get(id: string): Promise<HostedExecutionStatus | undefined>;
    cancel(id: string): Promise<HostedExecutionStatus | undefined>;
  }
): Promise<Response> {
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

  const match = /^\/([^/]+)(\/cancel)?$/.exec(path);
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
    const cancel = match?.[2] !== undefined;
    if (request.method !== (cancel ? "POST" : "GET"))
      return errorResponse(
        405,
        "method_not_allowed",
        "Method not allowed.",
        "Use GET for status or POST to request cancellation."
      );
    const status = await (cancel ? app.cancel(id) : app.get(id));
    if (status) {
      const cancelling = cancel && status.cancellationRequested && status.state === "running";
      return jsonResponse(status, cancelling ? 202 : 200);
    }
  }
  return errorResponse(
    404,
    "execution_not_found",
    "Execution not found.",
    "Use the ID from an admission receipt."
  );
}
