import type { StoredPipelineDefinition } from "../../run-store/run-store.js";
import type { PipelinePlan, PipelineRunControls } from "../../core/pipeline.js";
import type {
  PipelineRunStudioCommand,
  PipelineRunStudioLaunchRequest,
} from "../shared/protocol.js";
import {
  parseStudioPayload,
  studioSnapshotSchema,
  studioCommandsSchema,
  studioPlanResponseSchema,
  studioRunDetailSchema,
  studioChildRunsSchema,
  studioTranscriptPageSchema,
  studioDefinitionSchema,
  studioDefinitionRunsSchema,
  studioCapabilitiesSchema,
  studioClearResultSchema,
  studioCancelResultSchema,
  studioLaunchResultSchema,
  type StudioSnapshot,
  type StudioRunDetail,
  type StudioChildRuns,
  type StudioTranscriptPage,
  type StudioDefinitionRuns,
  type StudioCapabilities,
  type StudioClearResult,
} from "../shared/schema.js";
import type { WireSchema } from "../../tracing/wire-schema.js";
export type {
  StudioSnapshot,
  StudioRunDetail,
  StudioChildRuns,
  StudioDefinitionRuns,
} from "../shared/schema.js";

export interface StudioHistoryQuery {
  /** Limit history to one pipeline's runs at any depth. */
  pipelineId?: string;
  query?: string;
  offset?: number;
  selectedRunId?: string | null;
}
export type StudioAccessDenied = 401 | 403;

class StudioHttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

export interface StudioApi {
  subscribeAccessDenied?(listener: (status: StudioAccessDenied) => void): () => void;
  cancelRun(runId: string): Promise<void>;
  clearHistory(): Promise<StudioClearResult>;
  loadCapabilities(): Promise<StudioCapabilities>;
  loadCommands(): Promise<PipelineRunStudioCommand[]>;
  loadRunDetail(runId: string): Promise<StudioRunDetail | null>;
  loadTranscript(
    runId: string,
    afterSequence?: number,
    signal?: AbortSignal
  ): Promise<StudioTranscriptPage>;
  loadChildRuns(runId: string, page: number): Promise<StudioChildRuns | null>;
  loadSnapshot(query?: StudioHistoryQuery): Promise<StudioSnapshot>;
  loadDefinition(pipelineId: string, definitionId?: string): Promise<StoredPipelineDefinition>;
  loadDefinitionRuns(
    pipelineId: string,
    definitionId?: string,
    offset?: number
  ): Promise<StudioDefinitionRuns>;
  launch(commandId: string, values: PipelineRunStudioLaunchRequest["values"]): Promise<string>;
  previewPlan(commandId: string, input: PipelineRunControls): Promise<PipelinePlan>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function responseError(value: unknown, fallback: string, status: number): Error {
  if (!isRecord(value)) return new StudioHttpError(status, fallback);
  if (Array.isArray(value.errors) && value.errors.every((item) => typeof item === "string")) {
    return new StudioHttpError(status, value.errors.join("\n"));
  }
  return new StudioHttpError(status, typeof value.message === "string" ? value.message : fallback);
}

function invalidResponse(endpoint: string): Error {
  return new Error(`Studio API returned an invalid response for ${endpoint}.`);
}

function decodeResponse<T>(schema: WireSchema<T>, payload: unknown, endpoint: string): T {
  const value = parseStudioPayload(schema, payload);
  if (value === undefined) throw invalidResponse(endpoint);
  return value;
}

/** Same-origin Studio transport. Every successful payload is validated before use. */
export function createStudioApi(fetcher: typeof fetch = fetch, mount = ""): StudioApi {
  const listeners = new Set<(status: StudioAccessDenied) => void>();
  let denied: StudioAccessDenied | undefined;
  let cachedSnapshot: { key: string; etag: string | null; snapshot: StudioSnapshot } | undefined;
  const assertAccess = () => {
    if (denied)
      throw new StudioHttpError(denied, denied === 401 ? "Sign in to continue." : "Access denied.");
  };
  const request: typeof fetch = async (input, init) => {
    assertAccess();
    const response = await fetcher(mount + String(input), init);
    if (!denied && (response.status === 401 || response.status === 403)) {
      denied = response.status;
      for (const listener of listeners) listener(denied);
    }
    assertAccess();
    return response;
  };
  const readJson = async (response: Response): Promise<unknown> => {
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      assertAccess();
      throw new StudioHttpError(response.status, "Studio API returned invalid JSON.");
    }
    assertAccess();
    return payload;
  };
  const readSuccess = async (response: Response, failure: string): Promise<unknown> => {
    const payload = await readJson(response);
    if (!response.ok) throw responseError(payload, failure, response.status);
    return payload;
  };
  return {
    subscribeAccessDenied(listener) {
      listeners.add(listener);
      if (denied) listener(denied);
      return () => {
        listeners.delete(listener);
      };
    },
    async loadSnapshot({
      query = "",
      offset = 0,
      pipelineId,
      selectedRunId,
    }: StudioHistoryQuery = {}) {
      const params = new URLSearchParams();
      if (pipelineId) params.set("pipeline", pipelineId);
      if (query) params.set("query", query);
      if (offset) params.set("offset", String(offset));
      if (selectedRunId) params.set("run", selectedRunId);
      const key = "/api/snapshot" + (params.size ? "?" + params : "");
      const previous = cachedSnapshot?.key === key ? cachedSnapshot : undefined;
      const response = await request(key, {
        cache: "no-store",
        headers: previous?.etag ? { "if-none-match": previous.etag } : undefined,
      });
      if (response.status === 304 && previous) return previous.snapshot;
      const payload = await readSuccess(response, "Snapshot request failed.");
      const snapshot = decodeResponse(studioSnapshotSchema, payload, "snapshot");
      cachedSnapshot = { key, etag: response.headers.get("etag"), snapshot };
      return snapshot;
    },
    async loadDefinition(pipelineId, definitionId) {
      const params = new URLSearchParams({ pipelineId });
      if (definitionId) params.set("definitionId", definitionId);
      const response = await request("/api/definitions?" + params, { cache: "no-store" });
      const payload = await readSuccess(response, "Definition request failed.");
      return decodeResponse(studioDefinitionSchema, payload, "definition").definition;
    },
    async loadDefinitionRuns(pipelineId, definitionId, offset = 0) {
      const params = new URLSearchParams({ pipelineId, offset: String(offset) });
      if (definitionId) params.set("definitionId", definitionId);
      const response = await request("/api/definitions/runs?" + params, { cache: "no-store" });
      const payload = await readSuccess(response, "Definition runs request failed.");
      return decodeResponse(studioDefinitionRunsSchema, payload, "definition runs");
    },
    async loadRunDetail(runId) {
      const response = await request("/api/runs/" + encodeURIComponent(runId), {
        cache: "no-store",
      });
      const payload = await readJson(response);
      if (response.status === 404) return null;
      if (!response.ok) throw responseError(payload, "Run detail request failed.", response.status);
      return decodeResponse(studioRunDetailSchema, payload, "run detail");
    },
    async loadChildRuns(runId, page) {
      const response = await request(
        "/api/runs/" + encodeURIComponent(runId) + "/children?page=" + page,
        { cache: "no-store" }
      );
      const payload = await readJson(response);
      if (response.status === 404) return null;
      if (!response.ok) throw responseError(payload, "Child runs request failed.", response.status);
      return decodeResponse(studioChildRunsSchema, payload, "child runs");
    },
    async loadTranscript(runId, afterSequence = 0, signal) {
      const response = await request(
        "/api/runs/" + encodeURIComponent(runId) + "/transcript?afterSequence=" + afterSequence,
        { cache: "no-store", signal }
      );
      const payload = await readSuccess(response, "Transcript request failed.");
      const page = decodeResponse(studioTranscriptPageSchema, payload, "transcript");
      if (
        page.transcript.runId !== runId ||
        page.transcript.records.some((record) => record.sequence <= afterSequence)
      )
        throw invalidResponse("transcript");
      return page;
    },
    async loadCommands() {
      const response = await request("/api/commands", { cache: "no-store" });
      const payload = await readSuccess(response, "Commands request failed.");
      return decodeResponse(studioCommandsSchema, payload, "commands").commands;
    },
    async loadCapabilities() {
      const response = await request("/api/capabilities", { cache: "no-store" });
      const payload = await readSuccess(response, "Capabilities request failed.");
      return decodeResponse(studioCapabilitiesSchema, payload, "capabilities");
    },
    async clearHistory() {
      const response = await request("/api/history", {
        method: "DELETE",
        headers: { "x-tubeless-studio-clear-history": "1" },
      });
      const payload = await readSuccess(response, "History could not be cleared.");
      const { eventCount } = decodeResponse(studioClearResultSchema, payload, "clear history");
      cachedSnapshot = undefined;
      return { eventCount };
    },
    async previewPlan(commandId, input) {
      const response = await request("/api/commands/" + encodeURIComponent(commandId) + "/plan", {
        method: "POST",
        headers: { "content-type": "application/json", "x-tubeless-studio-plan": "1" },
        body: JSON.stringify(input),
      });
      const payload = await readSuccess(response, "Plan request failed.");
      return decodeResponse(studioPlanResponseSchema, payload, "plan").plan;
    },
    async cancelRun(runId) {
      const response = await request("/api/runs/" + encodeURIComponent(runId) + "/cancel", {
        method: "POST",
        headers: { "x-tubeless-studio-cancel": "1" },
      });
      const payload = await readSuccess(response, "Run could not be cancelled.");
      const result = decodeResponse(studioCancelResultSchema, payload, "cancel run");
      if (result.runId !== runId) throw invalidResponse("cancel run");
    },
    async launch(commandId, values) {
      const response = await request("/api/commands/" + encodeURIComponent(commandId) + "/runs", {
        method: "POST",
        headers: { "content-type": "application/json", "x-tubeless-studio-launch": "1" },
        body: JSON.stringify({ values }),
      });
      const payload = await readSuccess(response, "Launch failed.");
      return decodeResponse(studioLaunchResultSchema, payload, "launch").runId;
    },
  };
}
