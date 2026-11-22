import type { CloudflareRunnerQueue } from "./cloudflare-runner-queue.js";
import { CollectorInputError, COLLECTOR_BATCH_BYTES } from "../hosting/collector-protocol.js";
import { HostedAttemptConflict } from "../hosting/attempt-store.js";
import { isLaunchIdentifier } from "../hosting/execution-status.js";
import {
  RUNNER_PATH,
  RUNNER_VALUE_BYTES,
  parseRunnerManifest,
  runnerProjectHeader,
} from "../hosting/runner-protocol.js";
import { errorResponse } from "../studio/server/http.js";
import { isJsonObject } from "../utilities/canonical-json.js";
import { BodyLimitError, readBoundedBody } from "../utilities/read-body.js";

export function isRunnerPath(path: string): boolean {
  return path === RUNNER_PATH || path.startsWith(`${RUNNER_PATH}/`);
}

/** Only the Worker router may call this RPC after authenticating the runner's service identity. */
export async function serveRunnerRequest(
  request: Request,
  queue: CloudflareRunnerQueue,
  projectId: string,
  deploymentId: string,
  definitions: ReadonlyMap<string, string>
): Promise<Response> {
  const path = new URL(request.url).pathname.slice(RUNNER_PATH.length);
  if (request.method !== "POST")
    return new Response(null, {
      status: 405,
      headers: { allow: "POST", "cache-control": "no-store" },
    });
  const suppliedDeployment = request.headers.get("x-tubeless-deployment");
  if (
    suppliedDeployment !== deploymentId ||
    request.headers.get("x-tubeless-project") !== runnerProjectHeader(projectId)
  )
    return errorResponse(
      409,
      "runner_revision_mismatch",
      "The runner project or deployment revision does not match this Worker.",
      "Start the runner with the deployed project and revision."
    );
  try {
    const bytes = await readBoundedBody(
      request.body,
      path === "/events" ? COLLECTOR_BATCH_BYTES : RUNNER_VALUE_BYTES,
      request.signal
    );
    let response: unknown;
    if (path === "/events") {
      const token = request.headers.get("x-tubeless-lease");
      if (!isLaunchIdentifier(token)) throw new TypeError("Invalid runner lease.");
      response = await queue.append(token, deploymentId, bytes);
    } else {
      const payload: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      if (!isJsonObject(payload)) throw new TypeError("Invalid runner message.");
      if (path === "/claim") {
        const manifest = parseRunnerManifest(payload.manifest);
        const compatible = new Map(
          [...manifest].filter(([id, definition]) => definitions.get(id) === definition)
        );
        response = await queue.claim(deploymentId, compatible);
      } else {
        if (!isLaunchIdentifier(payload.id) || !isLaunchIdentifier(payload.token))
          throw new TypeError("Invalid runner lease.");
        if (path === "/heartbeat")
          response = await queue.heartbeat(payload.id, payload.token, deploymentId);
        else if (path === "/finish" && Object.hasOwn(payload, "result"))
          response = await queue.finish(payload.id, payload.token, deploymentId, payload.result);
        else
          return errorResponse(
            404,
            "runner_operation_unknown",
            "Unknown runner operation.",
            "Check the runner version."
          );
      }
    }
    return Response.json(response, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (
      error instanceof BodyLimitError ||
      (error instanceof CollectorInputError && error.status === 413)
    )
      return errorResponse(
        413,
        "runner_message_too_large",
        "The runner message exceeds its byte limit.",
        "Reduce the message size."
      );
    if (error instanceof HostedAttemptConflict)
      return errorResponse(
        409,
        "runner_event_conflict",
        "The runner events do not match the claimed run.",
        "Inspect the lease and run history."
      );
    if (
      error instanceof TypeError ||
      error instanceof SyntaxError ||
      error instanceof CollectorInputError
    )
      return errorResponse(
        400,
        "runner_message_invalid",
        "The runner message is invalid.",
        "Check the runner version and message format."
      );
    throw error;
  }
}
