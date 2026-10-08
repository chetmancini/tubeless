/** Internal transport contracts for the first-party Cloud CLI API. */
export type CloudJsonValue =
  | null
  | string
  | number
  | boolean
  | CloudJsonValue[]
  | { [key: string]: CloudJsonValue };

export type CloudRole = "owner" | "admin" | "member" | "viewer";
export type CloudRunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface CliWorkspace {
  id: string;
  name: string;
  slug: string;
  plan: "free" | "team" | "scale";
  createdAt: number;
  spendCap: number;
  role: CloudRole;
}

export interface CliSession {
  user: { id: string; login: string; name: string; email: string; avatar: string };
  expiresAt: number;
  workspaces: CliWorkspace[];
}

export interface CliRepository {
  id: string;
  fullName: string;
  branch: string;
}

export interface CliPipeline {
  id: string;
  name: string;
  repositoryId: string;
  path: string;
  registryPath?: string;
  exportName?: string;
  pipelineId?: string;
  branch: string;
  commit: string;
  enabled: boolean;
  headState?: "present" | "missing";
  available: boolean;
}

export interface CliAddPipeline {
  repositoryId: string;
  branch?: string;
  path: string;
  name?: string;
  registryPath?: string;
  exportName?: string;
  pipelineId?: string;
}

export interface CliRunRequest {
  pipelineId: string;
  input: Record<string, CloudJsonValue>;
}

export interface CliLogLine {
  time: number;
  level: "info" | "warn" | "error";
  message: string;
}

export interface CliRun {
  id: string;
  pipelineId: string;
  pipelineName: string;
  status: CloudRunStatus;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  durationMs: number;
  commit: string;
  branch: string;
  trigger: "manual" | "push" | "rerun" | "schedule";
  schedule?: { id: string; name: string; scheduledAt: number; timezone: string };
  actor: string;
  steps: {
    id: string;
    name: string;
    status: CloudRunStatus | "pending" | "skipped";
    durationMs: number;
    dependencies: string[];
    error?: string;
  }[];
  logs: CliLogLine[];
  artifacts: { name: string; size: number; contentType: string }[];
  artifactStorageId?: string;
  result?: CloudJsonValue;
  error?: string;
  input: Record<string, CloudJsonValue>;
}

export interface CloudDeviceCode {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

export interface CloudDeviceSession {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  scope: string;
}

export interface CloudDeviceError {
  error: string;
  error_description?: string;
}

export type CliErrorCode =
  | "unauthenticated"
  | "forbidden"
  | "invalid_request"
  | "not_found"
  | "conflict"
  | "rate_limited"
  | "quota_exceeded"
  | "unavailable"
  | "internal_error";

const RUN_STATUSES = ["queued", "running", "completed", "failed", "cancelled"];
const ERROR_CODES = [
  "unauthenticated",
  "forbidden",
  "invalid_request",
  "not_found",
  "conflict",
  "rate_limited",
  "quota_exceeded",
  "unavailable",
  "internal_error",
];

export function isCloudObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, allowEmpty = false): value is string {
  return typeof value === "string" && (allowEmpty || value.length > 0);
}

function number(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function optionalText(value: unknown): boolean {
  return value === undefined || text(value, true);
}

function optionalNumber(value: unknown): boolean {
  return value === undefined || number(value);
}

function hasTexts(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return fields.every((field) => text(value[field], true));
}

function parseResponse<T>(value: unknown, valid: boolean, name: string): T {
  if (!valid) throw new Error(`Invalid Cloud ${name} response.`);
  // SAFETY: each caller checks the complete transport shape before returning it.
  return value as T;
}

export function parseCliSession(value: unknown): CliSession {
  const valid =
    isCloudObject(value) &&
    number(value.expiresAt) &&
    value.expiresAt <= 8.64e15 &&
    isCloudObject(value.user) &&
    hasTexts(value.user, ["id", "login", "name", "email", "avatar"]) &&
    text(value.user.id) &&
    Array.isArray(value.workspaces) &&
    value.workspaces.every(
      (workspace: unknown) =>
        isCloudObject(workspace) &&
        hasTexts(workspace, ["id", "name", "slug"]) &&
        text(workspace.id) &&
        ["free", "team", "scale"].includes(String(workspace.plan)) &&
        ["owner", "admin", "member", "viewer"].includes(String(workspace.role)) &&
        number(workspace.createdAt) &&
        number(workspace.spendCap)
    );
  return parseResponse(value, valid, "session");
}

export function parseCliRepositories(value: unknown): CliRepository[] {
  return parseResponse(
    value,
    Array.isArray(value) &&
      value.every(
        (repository: unknown) =>
          isCloudObject(repository) &&
          ["id", "fullName", "branch"].every((field) => text(repository[field]))
      ),
    "repositories"
  );
}

function isPipeline(value: unknown): boolean {
  return (
    isCloudObject(value) &&
    ["id", "name", "repositoryId", "path", "branch", "commit"].every((field) =>
      text(value[field])
    ) &&
    ["registryPath", "exportName", "pipelineId"].every((field) => optionalText(value[field])) &&
    typeof value.enabled === "boolean" &&
    typeof value.available === "boolean" &&
    (value.headState === undefined || ["present", "missing"].includes(String(value.headState)))
  );
}

export function parseCliPipeline(value: unknown): CliPipeline {
  return parseResponse(value, isPipeline(value), "pipeline");
}

export function parseCliPipelines(value: unknown): CliPipeline[] {
  return parseResponse(value, Array.isArray(value) && value.every(isPipeline), "pipelines");
}

export function parseCliRun(value: unknown): CliRun {
  const valid =
    isCloudObject(value) &&
    ["id", "pipelineId", "pipelineName", "commit", "branch", "actor"].every((field) =>
      text(value[field])
    ) &&
    RUN_STATUSES.includes(String(value.status)) &&
    ["manual", "push", "rerun", "schedule"].includes(String(value.trigger)) &&
    number(value.createdAt) &&
    number(value.durationMs) &&
    optionalNumber(value.startedAt) &&
    optionalNumber(value.finishedAt) &&
    optionalText(value.error) &&
    optionalText(value.artifactStorageId) &&
    isCloudObject(value.input) &&
    (value.schedule === undefined ||
      (isCloudObject(value.schedule) &&
        hasTexts(value.schedule, ["id", "name", "timezone"]) &&
        number(value.schedule.scheduledAt))) &&
    Array.isArray(value.steps) &&
    value.steps.every(
      (step: unknown) =>
        isCloudObject(step) &&
        hasTexts(step, ["id", "name"]) &&
        [...RUN_STATUSES, "pending", "skipped"].includes(String(step.status)) &&
        number(step.durationMs) &&
        optionalText(step.error) &&
        Array.isArray(step.dependencies) &&
        step.dependencies.every((dependency: unknown) => text(dependency))
    ) &&
    Array.isArray(value.logs) &&
    value.logs.length <= 400 &&
    value.logs.every(
      (log: unknown) =>
        isCloudObject(log) &&
        number(log.time) &&
        ["info", "warn", "error"].includes(String(log.level)) &&
        text(log.message, true)
    ) &&
    Array.isArray(value.artifacts) &&
    value.artifacts.every(
      (artifact: unknown) =>
        isCloudObject(artifact) &&
        hasTexts(artifact, ["name", "contentType"]) &&
        number(artifact.size)
    );
  return parseResponse(value, valid, "run");
}

export function parseCloudDeviceCode(value: unknown): CloudDeviceCode {
  const valid =
    isCloudObject(value) &&
    ["device_code", "user_code", "verification_uri", "verification_uri_complete"].every((field) =>
      text(value[field])
    ) &&
    number(value.expires_in) &&
    value.expires_in > 0 &&
    value.expires_in <= 3600 &&
    number(value.interval) &&
    value.interval > 0 &&
    value.interval <= 60;
  return parseResponse(value, valid, "device authorization");
}

export function parseCloudDeviceSession(value: unknown): CloudDeviceSession {
  return parseResponse(
    value,
    isCloudObject(value) &&
      text(value.access_token) &&
      value.access_token.length <= 4096 &&
      /^[\x21-\x7e]+$/.test(value.access_token) &&
      value.token_type === "Bearer" &&
      number(value.expires_in) &&
      value.expires_in > 0 &&
      value.expires_in <= 365 * 24 * 60 * 60 &&
      text(value.scope, true),
    "device session"
  );
}

export function parseCliError(value: unknown): { code: CliErrorCode; message: string } | undefined {
  if (
    !isCloudObject(value) ||
    !isCloudObject(value.error) ||
    !ERROR_CODES.includes(String(value.error.code)) ||
    !text(value.error.message)
  ) {
    return undefined;
  }
  // SAFETY: the error code allowlist and message were checked above.
  return value.error as { code: CliErrorCode; message: string };
}

export function parseCloudDeviceError(value: unknown): CloudDeviceError | undefined {
  if (!isCloudObject(value) || !text(value.error) || !optionalText(value.error_description)) {
    return undefined;
  }
  return {
    error: value.error,
    ...(value.error_description === undefined
      ? {}
      : { error_description: String(value.error_description) }),
  };
}
