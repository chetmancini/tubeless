import { awaitWithAbort } from "../../utilities/abort.js";
import { isJsonObject } from "../../utilities/canonical-json.js";
import { normalizeCloudHost } from "./config.js";
import {
  CloudClientError,
  parseCloudSource,
  CLOUD_INPUT_MAX_DEPTH,
  CLOUD_INPUT_MAX_BYTES,
  isCloudJsonValue,
  isCloudToken,
  isCloudAutomationToken,
  isCloudIdempotencyKey,
  isCloudRunStatus,
  parseCliError,
  parseCliPipelines,
  parseCliRun,
  parseCliSession,
  parseCloudDeviceCode,
  parseCloudDeviceError,
  parseCloudDeviceSession,
  type CliPipeline,
  type CloudRunStatus,
  type CliRun,
  type CliRunRequest,
  type CliSession,
  type CloudDeviceCode,
  type CloudDeviceError,
  type CloudDeviceSession,
} from "./protocol.js";
import { terminalSafeText } from "../workbench-shared.js";
import { redactCloudText } from "./credentials.js";
import { cancelBody } from "../../utilities/read-body.js";
import { readManifest, responseJson, writeArtifact } from "./response.js";
import {
  FOLLOW_MEDIA_TYPE,
  isFollowCursor,
  readFollowStream,
  assertRunFollowingCapability,
  type FollowBoundary,
  type FollowEvent,
} from "./follow-protocol.js";

const RUN_ENVELOPE_LIMIT = 68 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const FOLLOW_REQUEST_TIMEOUT_MS = 35_000;

type ReadResponse<T> = (
  response: Response,
  signal: AbortSignal,
  refreshTimeout: () => void
) => Promise<T>;

export function isCloudTransportError(error: unknown): error is CloudClientError {
  return (
    error instanceof CloudClientError &&
    error.status === undefined &&
    ["transport_error", "timeout"].includes(error.code)
  );
}

export interface CloudClientOptions {
  host: string;
  token?: string;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface CliCancelResult {
  runId: string;
  status: CloudRunStatus;
  /** True when the run had already reached a terminal state before cancellation. */
  alreadyFinished: boolean;
}

export interface CloudClient {
  readonly host: string;
  session(): Promise<CliSession>;
  logout(): Promise<void>;
  pipelines(workspaceId: string): Promise<CliPipeline[]>;
  run(workspaceId: string, request: CliRunRequest, idempotencyKey: string): Promise<CliRun>;
  getRun(workspaceId: string, runId: string): Promise<CliRun>;
  cancelRun(workspaceId: string, runId: string): Promise<CliCancelResult>;
  downloadArtifact(
    workspaceId: string,
    runId: string,
    name: string,
    write: (bytes: Uint8Array) => Promise<void>
  ): Promise<void>;
  getManifest(workspaceId: string, runId: string): Promise<Uint8Array>;
  requireRunFollowing(workspaceId: string, session?: CliSession): Promise<void>;
  followRun(
    workspaceId: string,
    runId: string,
    cursor: string | undefined,
    consume: (event: FollowEvent, signal: AbortSignal) => Promise<void>
  ): Promise<FollowBoundary>;
  deviceCode(): Promise<CloudDeviceCode>;
  deviceToken(deviceCode: string): Promise<CloudDeviceSession | CloudDeviceError>;
}

function safeMessage(message: string, token?: string): string {
  return terminalSafeText(redactCloudText(message, token)).slice(0, 1024);
}

function abortFailure(timedOut: boolean): CloudClientError {
  return new CloudClientError(
    timedOut ? "Cloud request timed out." : "Cloud request interrupted.",
    timedOut ? "timeout" : "cancelled"
  );
}

function validateRunInput(input: unknown): void {
  if (!isJsonObject(input))
    throw new CloudClientError("Cloud run input must be a JSON object.", "invalid_request");
  if (!isCloudJsonValue(input))
    throw new CloudClientError(
      `Cloud run input must contain JSON data with finite numbers and at most ${CLOUD_INPUT_MAX_DEPTH} levels of objects and arrays.`,
      "invalid_request"
    );
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(input);
  } catch {
    throw new CloudClientError("Cloud run input must contain JSON data.", "invalid_request");
  }
  if (encoded === undefined || Buffer.byteLength(encoded, "utf8") > CLOUD_INPUT_MAX_BYTES)
    throw new CloudClientError("Cloud run input exceeds the 64 KB JSON limit.", "invalid_request");
}

/** Bounded, origin-bound HTTP. Commands own admission and observation retry policy. */
export function createCloudClient(options: CloudClientOptions): CloudClient {
  const host = normalizeCloudHost(options.host);
  const fetcher = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120_000) {
    throw new CloudClientError(
      "Cloud request timeout must be between 1 and 120000 milliseconds.",
      "invalid_request"
    );
  }
  if (options.token !== undefined && !isCloudToken(options.token)) {
    throw new CloudClientError(
      "The Cloud credential is invalid. Run tubeless auth login again.",
      "unauthenticated"
    );
  }

  interface RequestOptions {
    accept?: string;
    timeoutMs?: number;
    body?: unknown;
    nativeAuth?: boolean;
    idempotencyKey?: string;
    bodyLimit?: number;
  }

  const request = async <T>(
    path: string | URL,
    read: ReadResponse<T>,
    requestOptions: RequestOptions = {}
  ): Promise<T> => {
    const url = new URL(path, host);
    if (url.origin !== host)
      throw new CloudClientError(
        "Cloud request must remain on the selected host.",
        "invalid_request"
      );
    if (!requestOptions.nativeAuth && !options.token)
      throw new CloudClientError(
        "No Cloud credential. Run tubeless auth login or set TUBELESS_TOKEN.",
        "unauthenticated"
      );

    const headers = new Headers({ Accept: requestOptions.accept ?? "application/json" });
    if (!requestOptions.nativeAuth) headers.set("Authorization", `Bearer ${options.token}`);
    if (requestOptions.idempotencyKey !== undefined)
      headers.set("Idempotency-Key", requestOptions.idempotencyKey);
    let body: string | undefined;
    if (requestOptions.body !== undefined) {
      try {
        body = JSON.stringify(requestOptions.body);
      } catch {
        throw new CloudClientError("Cloud request must contain JSON data.", "invalid_request");
      }
      const bodyLimit = requestOptions.bodyLimit ?? CLOUD_INPUT_MAX_BYTES;
      if (body === undefined || Buffer.byteLength(body, "utf8") > bodyLimit)
        throw new CloudClientError(
          `Cloud request exceeds the ${bodyLimit / 1024} KB JSON limit.`,
          "invalid_request"
        );
      headers.set("Content-Type", "application/json");
    }

    const deadline = new AbortController();
    const signal = options.signal
      ? AbortSignal.any([options.signal, deadline.signal])
      : deadline.signal;
    const timer = setTimeout(() => deadline.abort(), requestOptions.timeoutMs ?? timeoutMs);
    const send = async () => {
      const response = await fetcher(url, {
        method: body === undefined ? "GET" : "POST",
        headers,
        body,
        redirect: "error",
        credentials: "omit",
        signal,
      });
      if (
        signal.aborted ||
        response.redirected ||
        (response.status >= 300 && response.status < 400)
      ) {
        cancelBody(response.body);
        signal.throwIfAborted();
        throw new CloudClientError(
          "Cloud redirects are rejected; select the service origin with --host.",
          "invalid_response",
          response.status
        );
      }
      return read(response, signal, () => {
        if (!signal.aborted) timer.refresh();
      });
    };
    try {
      signal.throwIfAborted();
      return await awaitWithAbort(send(), signal, "Cloud request");
    } catch (error) {
      if (signal.aborted) throw abortFailure(deadline.signal.aborted);
      if (error instanceof CloudClientError) throw error;
      // A fetch implementation's diagnostic may include credential headers.
      throw new CloudClientError(
        "Cloud request failed. Check the selected host and network connection.",
        "transport_error"
      );
    } finally {
      clearTimeout(timer);
      deadline.abort();
    }
  };

  function responseError(response: Response, value: unknown): CloudClientError {
    const error = parseCliError(value);
    return new CloudClientError(
      error
        ? safeMessage(error.message, options.token)
        : `Cloud request failed (HTTP ${response.status}).`,
      error?.code ?? (response.status === 429 ? "rate_limited" : "invalid_response"),
      response.status
    );
  }

  const requestJson = <T>(
    path: string,
    decode: (value: unknown) => T,
    requestOptions: RequestOptions & { devicePolling?: boolean } = {}
  ) =>
    request(
      path,
      async (response, signal) => {
        const value = await responseJson(response, signal);
        if (!response.ok) {
          const deviceError = requestOptions.nativeAuth ? parseCloudDeviceError(value) : undefined;
          if (!deviceError) throw responseError(response, value);
          if (requestOptions.devicePolling) return decode(deviceError);
          throw new CloudClientError(
            safeMessage(deviceError.error_description ?? "Device authorization failed."),
            deviceError.error,
            response.status
          );
        }
        try {
          return decode(value);
        } catch {
          throw new CloudClientError(
            "Cloud returned an invalid response shape.",
            "invalid_response",
            response.status
          );
        }
      },
      requestOptions
    );

  const segment = (id: string, label = "workspace or run ID") => {
    if (
      !id ||
      id === "." ||
      id === ".." ||
      /[\ud800-\udfff]/u.test(id) ||
      (options.token && id.includes(options.token))
    )
      throw new CloudClientError(`Invalid Cloud ${label}.`, "invalid_request");
    return encodeURIComponent(id);
  };
  const workspacePath = (workspace: string) => `/api/v1/workspaces/${segment(workspace)}`;
  const runPath = (workspace: string, runId: string) =>
    `${workspacePath(workspace)}/runs/${segment(runId)}`;
  const download = <T>(path: string, accept: string, consume: ReadResponse<T>) =>
    request(
      path,
      async (response, signal, refreshTimeout) => {
        if (!response.ok) throw responseError(response, await responseJson(response, signal));
        if (response.status !== 200) {
          cancelBody(response.body);
          throw new CloudClientError(
            "Cloud returned an incomplete download response.",
            "invalid_response",
            response.status
          );
        }
        return consume(response, signal, refreshTimeout);
      },
      { accept }
    );
  const session = () => requestJson("/api/v1/session", parseCliSession);
  return {
    host,
    session,
    logout: () =>
      requestJson(
        "/api/v1/auth/logout",
        (value) => {
          if (!isJsonObject(value) || value.ok !== true) throw new Error("Invalid logout response");
        },
        { body: {} }
      ),
    pipelines: (workspace) =>
      requestJson(`${workspacePath(workspace)}/pipelines`, parseCliPipelines),
    run: async (workspace, body, idempotencyKey) => {
      if (!isCloudIdempotencyKey(idempotencyKey)) {
        throw new CloudClientError("Invalid Cloud run idempotency key.", "invalid_request");
      }
      validateRunInput(body.input);
      const source = body.source === undefined ? undefined : parseCloudSource(body.source);
      return requestJson(
        `${workspacePath(workspace)}/runs`,
        (value) => {
          const run = parseCliRun(value);
          if (run.pipelineId !== body.pipelineId)
            throw new Error("Cloud returned a different pipeline.");
          return run;
        },
        {
          body: { pipelineId: body.pipelineId, input: body.input, ...(source ? { source } : {}) },
          idempotencyKey,
          bodyLimit: RUN_ENVELOPE_LIMIT,
        }
      );
    },
    getRun: async (workspace, runId) =>
      requestJson(runPath(workspace, runId), (value) => {
        const run = parseCliRun(value);
        if (run.id !== runId) throw new Error("Cloud returned a different run.");
        return run;
      }),
    cancelRun: async (workspace, runId) =>
      requestJson(
        `${runPath(workspace, runId)}/cancel`,
        (value) => {
          if (
            !isJsonObject(value) ||
            value.runId !== runId ||
            !isCloudRunStatus(value.status) ||
            typeof value.alreadyFinished !== "boolean"
          )
            throw new Error("Invalid Cloud cancellation receipt.");
          return { runId, status: value.status, alreadyFinished: value.alreadyFinished };
        },
        { body: {} }
      ),
    downloadArtifact: async (workspace, runId, name, write) =>
      download(
        `${runPath(workspace, runId)}/artifacts/${segment(name, "artifact name")}`,
        "*/*",
        (response, signal, refreshTimeout) =>
          writeArtifact(response.body, signal, write, refreshTimeout)
      ),
    getManifest: async (workspace, runId) =>
      download(
        `${runPath(workspace, runId)}/reproduction`,
        "application/json",
        (response, signal) => readManifest(response, runId, signal)
      ),
    requireRunFollowing: async (workspace, discoveredSession) => {
      const capability =
        options.token && isCloudAutomationToken(options.token)
          ? await requestJson(`${workspacePath(workspace)}/automation`, (value) => {
              if (
                !isJsonObject(value) ||
                value.workspaceId !== workspace ||
                typeof value.principalId !== "string" ||
                !value.principalId ||
                !Array.isArray(value.scopes) ||
                !value.scopes.every((scope: unknown) => typeof scope === "string")
              )
                throw new Error("Invalid Cloud automation discovery.");
              return value.runFollowing;
            })
          : (discoveredSession ?? (await session())).runFollowing;
      assertRunFollowingCapability(capability);
    },
    followRun: async (workspace, runId, cursor, consume) => {
      const url = new URL(`${runPath(workspace, runId)}/events`, host);
      if (cursor !== undefined) {
        if (!isFollowCursor(cursor) || (options.token && cursor.includes(options.token)))
          throw new CloudClientError("Invalid Cloud run-following cursor.", "invalid_request");
        url.searchParams.set("cursor", cursor);
      }
      return request(
        url,
        async (response, signal) => {
          if (!response.ok) throw responseError(response, await responseJson(response, signal));
          const mediaType = response.headers
            .get("content-type")
            ?.split(";", 1)[0]
            .trim()
            .toLowerCase();
          if (mediaType !== FOLLOW_MEDIA_TYPE || !response.body) {
            cancelBody(response.body);
            throw new CloudClientError(
              "Cloud returned an invalid run-following content type or body.",
              "invalid_response",
              response.status
            );
          }
          return readFollowStream(response.body, workspace, runId, signal, async (event) => {
            if (options.token && event.cursor.includes(options.token))
              throw new CloudClientError(
                "Cloud returned an invalid run-following cursor.",
                "invalid_response"
              );
            try {
              await consume(event, signal);
            } catch (error) {
              if (error instanceof CloudClientError || signal.aborted) throw error;
              throw new CloudClientError(
                "Could not write Cloud observation output.",
                "observation_output_error"
              );
            }
          });
        },
        { accept: FOLLOW_MEDIA_TYPE, timeoutMs: Math.max(FOLLOW_REQUEST_TIMEOUT_MS, timeoutMs) }
      );
    },
    deviceCode: () =>
      requestJson("/api/auth/device/code", parseCloudDeviceCode, {
        nativeAuth: true,
        body: { client_id: "tubeless-cli" },
      }),
    deviceToken: (deviceCode) =>
      requestJson(
        "/api/auth/device/token",
        (value) => parseCloudDeviceError(value) ?? parseCloudDeviceSession(value),
        {
          nativeAuth: true,
          devicePolling: true,
          body: {
            client_id: "tubeless-cli",
            device_code: deviceCode,
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          },
        }
      ),
  };
}

/** Only open approval URLs from the selected service, never arbitrary redirect destinations. */
export function cloudVerificationUrl(host: string, value: string): string {
  const origin = normalizeCloudHost(host);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CloudClientError(
      "Cloud returned an invalid device verification URL.",
      "invalid_response"
    );
  }
  if (
    url.origin !== origin ||
    url.username ||
    url.password ||
    value.includes("#") ||
    /^https?:\/\/[^/]*@/i.test(value)
  ) {
    throw new CloudClientError(
      "Cloud verification URL must belong to the selected host.",
      "invalid_response"
    );
  }
  return url.href;
}
