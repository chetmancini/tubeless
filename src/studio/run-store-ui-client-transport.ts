import type { PipelinePlan, PipelineRunControls } from "../core/pipeline.js";
import type {
  StoredPipelineLog,
  StoredPipelineRun,
  StoredPipelineStep,
} from "../run-store/run-store.js";
import type { StudioRunDetail, StudioSnapshot } from "./run-store-ui-client-model.js";
import {
  isPipelineRunStudioParameter,
  type PipelineRunStudioCommand,
  type PipelineRunStudioLaunchRequest,
} from "./run-store-ui-protocol.js";

interface StudioCapabilities {
  canCancel: boolean;
  canClearHistory: boolean;
}

interface StudioClearResult {
  eventCount: number;
}

export interface StudioApi {
  cancelRun(runId: string): Promise<void>;
  clearHistory(): Promise<StudioClearResult>;
  loadCapabilities(): Promise<StudioCapabilities>;
  loadCommands(): Promise<PipelineRunStudioCommand[]>;
  loadRunDetail(runId: string): Promise<StudioRunDetail | null>;
  loadSnapshot(): Promise<StudioSnapshot>;
  launch(commandId: string, values: PipelineRunStudioLaunchRequest["values"]): Promise<string>;
  previewPlan(commandId: string, input: PipelineRunControls): Promise<PipelinePlan>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function isOptionalFiniteNumber(value: unknown): value is number | undefined {
  return value === undefined || isFiniteNumber(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isStoredLog(value: unknown): value is StoredPipelineLog {
  if (!isRecord(value)) return false;
  return (
    isFiniteNumber(value.id) &&
    (value.level === "error" || value.level === "log" || value.level === "warn") &&
    typeof value.message === "string" &&
    isFiniteNumber(value.timestampMs) &&
    isOptionalString(value.attemptId) &&
    isOptionalString(value.stepId)
  );
}

function isStoredStep(value: unknown): value is StoredPipelineStep {
  if (!isRecord(value)) return false;
  if (
    typeof value.id !== "string" ||
    !["cancelled", "completed", "failed", "planned", "running", "skipped"].includes(
      String(value.status)
    ) ||
    !isOptionalString(value.description) ||
    !isOptionalString(value.name) ||
    !isOptionalFiniteNumber(value.durationMs) ||
    !isOptionalFiniteNumber(value.finishedAtMs) ||
    !isOptionalFiniteNumber(value.startedAtMs)
  ) {
    return false;
  }
  if (value.attempt !== undefined) {
    if (
      !isRecord(value.attempt) ||
      typeof value.attempt.attemptId !== "string" ||
      !isOptionalFiniteNumber(value.attempt.durationMs) ||
      !isOptionalFiniteNumber(value.attempt.finishedAtMs) ||
      !Array.isArray(value.attempt.retries) ||
      !value.attempt.retries.every(isFiniteNumber) ||
      !isFiniteNumber(value.attempt.startedAtMs) ||
      !["cancelled", "completed", "failed", "running", "skipped"].includes(
        String(value.attempt.status)
      )
    ) {
      return false;
    }
  }
  if (value.progress !== undefined) {
    if (!isRecord(value.progress) || !isFiniteNumber(value.progress.completed)) return false;
    if (
      !isOptionalFiniteNumber(value.progress.detailCount) ||
      !isOptionalString(value.progress.message) ||
      !isOptionalFiniteNumber(value.progress.total)
    ) {
      return false;
    }
    if (
      value.progress.details !== undefined &&
      (!Array.isArray(value.progress.details) ||
        !value.progress.details.every(
          (detail) =>
            isRecord(detail) &&
            typeof detail.id === "string" &&
            isOptionalString(detail.label) &&
            isOptionalString(detail.status)
        ))
    ) {
      return false;
    }
  }
  if (value.nestedPipeline !== undefined) {
    if (
      !isRecord(value.nestedPipeline) ||
      (value.nestedPipeline.mode !== "single" && value.nestedPipeline.mode !== "for-each") ||
      typeof value.nestedPipeline.pipelineId !== "string" ||
      !isFiniteNumber(value.nestedPipeline.stepCount) ||
      !isStringArray(value.nestedPipeline.stepIds)
    ) {
      return false;
    }
  }
  if (value.remote !== undefined) {
    if (
      !isRecord(value.remote) ||
      typeof value.remote.engine !== "string" ||
      !isOptionalString(value.remote.target)
    ) {
      return false;
    }
  }
  return true;
}

function isStoredStudioRun(value: unknown): value is StoredPipelineRun {
  if (!isRecord(value)) return false;
  return (
    typeof value.dryRun === "boolean" &&
    isFiniteNumber(value.eventCount) &&
    isFiniteNumber(value.logCount) &&
    Array.isArray(value.logs) &&
    value.logs.every(isStoredLog) &&
    typeof value.pipelineId === "string" &&
    typeof value.runId === "string" &&
    isFiniteNumber(value.startedAtMs) &&
    isOptionalFiniteNumber(value.durationMs) &&
    isOptionalFiniteNumber(value.finishedAtMs) &&
    ["cancelled", "completed", "failed", "running"].includes(String(value.status)) &&
    Array.isArray(value.steps) &&
    value.steps.every(isStoredStep) &&
    isFiniteNumber(value.version) &&
    isOptionalString(value.correlationId) &&
    isOptionalString(value.parentRunId) &&
    (value.error === undefined ||
      (isRecord(value.error) &&
        typeof value.error.code === "string" &&
        typeof value.error.kind === "string" &&
        typeof value.error.message === "string" &&
        typeof value.error.phase === "string"))
  );
}

function isStudioSnapshot(value: unknown): value is StudioSnapshot {
  if (!isRecord(value)) return false;
  if (
    !isFiniteNumber(value.activeRunCount) ||
    !isFiniteNumber(value.completedRunCount) ||
    !Array.isArray(value.definitions) ||
    !isFiniteNumber(value.failedRunCount) ||
    !isFiniteNumber(value.generatedAtMs) ||
    !isFiniteNumber(value.lastEventId) ||
    !Array.isArray(value.runs) ||
    !value.runs.every(isStoredStudioRun) ||
    (value.liveRunIds !== undefined && !isStringArray(value.liveRunIds))
  ) {
    return false;
  }
  return true;
}

export function parseStudioSnapshot(value: unknown): StudioSnapshot | undefined {
  return isStudioSnapshot(value) ? value : undefined;
}

function isStudioCommand(value: unknown): value is PipelineRunStudioCommand {
  return (
    isRecord(value) &&
    typeof value.canPlan === "boolean" &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    isOptionalString(value.description) &&
    Array.isArray(value.parameters) &&
    value.parameters.every(isPipelineRunStudioParameter)
  );
}

export function parseStudioCommands(value: unknown): PipelineRunStudioCommand[] | undefined {
  if (
    !isRecord(value) ||
    !Array.isArray(value.commands) ||
    !value.commands.every(isStudioCommand)
  ) {
    return undefined;
  }
  return value.commands;
}

function isStudioPlanPayload(value: unknown): value is { plan: PipelinePlan } {
  if (!isRecord(value) || !isRecord(value.plan)) return false;
  const plan = value.plan;
  if (
    typeof plan.dryRun !== "boolean" ||
    !Array.isArray(plan.errors) ||
    !plan.errors.every((error) => isRecord(error) && typeof error.message === "string") ||
    typeof plan.ok !== "boolean" ||
    typeof plan.pipelineId !== "string" ||
    !Array.isArray(plan.steps)
  ) {
    return false;
  }
  for (const step of plan.steps) {
    if (
      !isRecord(step) ||
      typeof step.id !== "string" ||
      !isStringArray(step.dependencies) ||
      typeof step.selected !== "boolean" ||
      !isOptionalString(step.description) ||
      !isOptionalString(step.name)
    ) {
      return false;
    }
    if (
      step.nestedPipeline !== undefined &&
      (!isRecord(step.nestedPipeline) ||
        (step.nestedPipeline.mode !== "single" && step.nestedPipeline.mode !== "for-each") ||
        typeof step.nestedPipeline.pipelineId !== "string" ||
        !isStringArray(step.nestedPipeline.stepIds))
    ) {
      return false;
    }
    if (
      step.remote !== undefined &&
      (!isRecord(step.remote) ||
        typeof step.remote.engine !== "string" ||
        !isOptionalString(step.remote.target))
    ) {
      return false;
    }
  }
  return true;
}

function parseStudioPlan(value: unknown): PipelinePlan | undefined {
  return isStudioPlanPayload(value) ? value.plan : undefined;
}

function responseError(value: unknown, fallback: string): Error {
  if (!isRecord(value)) return new Error(fallback);
  if (Array.isArray(value.errors) && value.errors.every((item) => typeof item === "string")) {
    return new Error(value.errors.join("\n"));
  }
  return new Error(
    typeof value.message === "string"
      ? value.message
      : typeof value.error === "string"
        ? value.error
        : fallback
  );
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new Error("Studio API returned invalid JSON.");
  }
}

function invalidResponse(endpoint: string): Error {
  return new Error(`Studio API returned an invalid response for ${endpoint}.`);
}

/** Same-origin Studio transport. Every successful payload is validated before use. */
export function createStudioApi(fetcher: typeof fetch = fetch): StudioApi {
  return {
    async loadSnapshot() {
      const response = await fetcher("/api/snapshot", { cache: "no-store" });
      const payload = await readJson(response);
      if (!response.ok) throw responseError(payload, "Snapshot request failed.");
      const snapshot = parseStudioSnapshot(payload);
      if (!snapshot) throw invalidResponse("snapshot");
      return snapshot;
    },
    async loadRunDetail(runId) {
      const response = await fetcher("/api/runs/" + encodeURIComponent(runId), {
        cache: "no-store",
      });
      const payload = await readJson(response);
      if (response.status === 404) return null;
      if (!response.ok) throw responseError(payload, "Run detail request failed.");
      if (!isRecord(payload) || !isStoredStudioRun(payload.run)) {
        throw invalidResponse("run detail");
      }
      return { run: payload.run };
    },
    async loadCommands() {
      const response = await fetcher("/api/commands", { cache: "no-store" });
      const payload = await readJson(response);
      if (!response.ok) throw responseError(payload, "Commands request failed.");
      const commands = parseStudioCommands(payload);
      if (!commands) throw invalidResponse("commands");
      return commands;
    },
    async loadCapabilities() {
      const response = await fetcher("/api/capabilities", { cache: "no-store" });
      const payload = await readJson(response);
      if (
        !response.ok ||
        !isRecord(payload) ||
        typeof payload.canCancel !== "boolean" ||
        typeof payload.canClearHistory !== "boolean"
      ) {
        if (!response.ok) throw responseError(payload, "Capabilities request failed.");
        throw invalidResponse("capabilities");
      }
      return {
        canCancel: payload.canCancel,
        canClearHistory: payload.canClearHistory,
      };
    },
    async clearHistory() {
      const response = await fetcher("/api/history", {
        method: "DELETE",
        headers: { "x-tubeless-studio-clear-history": "1" },
      });
      const payload = await readJson(response);
      if (!response.ok) throw responseError(payload, "History could not be cleared.");
      if (!isRecord(payload) || payload.cleared !== true || !isFiniteNumber(payload.eventCount)) {
        throw invalidResponse("clear history");
      }
      return { eventCount: payload.eventCount };
    },
    async previewPlan(commandId, input) {
      const response = await fetcher("/api/commands/" + encodeURIComponent(commandId) + "/plan", {
        method: "POST",
        headers: { "content-type": "application/json", "x-tubeless-studio-plan": "1" },
        body: JSON.stringify(input),
      });
      const payload = await readJson(response);
      if (!response.ok) throw responseError(payload, "Plan request failed.");
      const plan = parseStudioPlan(payload);
      if (!plan) throw invalidResponse("plan");
      return plan;
    },
    async cancelRun(runId) {
      const response = await fetcher("/api/runs/" + encodeURIComponent(runId) + "/cancel", {
        method: "POST",
        headers: { "x-tubeless-studio-cancel": "1" },
      });
      const payload = await readJson(response);
      if (!response.ok) throw responseError(payload, "Run could not be cancelled.");
      if (!isRecord(payload) || payload.cancelled !== true || payload.runId !== runId) {
        throw invalidResponse("cancel run");
      }
    },
    async launch(commandId, values) {
      const response = await fetcher("/api/commands/" + encodeURIComponent(commandId) + "/runs", {
        method: "POST",
        headers: { "content-type": "application/json", "x-tubeless-studio-launch": "1" },
        body: JSON.stringify({ values }),
      });
      const payload = await readJson(response);
      if (!response.ok) throw responseError(payload, "Launch failed.");
      if (
        !isRecord(payload) ||
        payload.accepted !== true ||
        typeof payload.runId !== "string" ||
        payload.runId.length === 0
      ) {
        throw invalidResponse("launch");
      }
      return payload.runId;
    },
  };
}
