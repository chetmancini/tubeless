import type { APIRoute } from "astro";
import { PACKAGE } from "../lib/package";
import { GITHUB_REPO, absUrl } from "../lib/paths";

const json = (schema: Record<string, unknown>) => ({
  content: { "application/json": { schema } },
});

const error = (name: string) => ({ $ref: `#/components/responses/${name}` });

const parameter = (name: string, description: string) => ({
  description,
  in: "path",
  name,
  required: true,
  schema: { type: "string" },
});

const guard = (name: string, description: string) => ({
  description,
  in: "header",
  name,
  required: true,
  schema: { const: "1", type: "string" },
});

const spec = {
  openapi: "3.1.0",
  info: {
    title: "Tubeless Local Studio API",
    version: PACKAGE.version,
    description:
      "HTTP contract for the local-only API started by `tubeless ui`. " +
      "The public tubeless.io site hosts this contract but does not execute pipelines.",
    license: { name: PACKAGE.license, url: `${GITHUB_REPO}/blob/main/LICENSE` },
  },
  externalDocs: {
    description: "Local Studio documentation",
    url: absUrl("docs/studio"),
  },
  servers: [
    {
      description: "Loopback-only Studio server (default port)",
      url: "http://127.0.0.1:{port}",
      variables: {
        port: {
          default: "4317",
          description: "Port printed by `tubeless ui`; it may differ when --port or port 0 is used.",
        },
      },
    },
  ],
  tags: [
    { name: "Observation", description: "Read projected run history." },
    { name: "Commands", description: "Inspect, plan, and launch registered commands." },
    { name: "Maintenance", description: "Optional cancellation and history maintenance." },
  ],
  paths: {
    "/api/snapshot": {
      get: {
        operationId: "getStudioSnapshot",
        summary: "Read the current projected run snapshot",
        tags: ["Observation"],
        responses: {
          "200": {
            description: "Current snapshot with log bodies omitted and live launch IDs included.",
            ...json({ $ref: "#/components/schemas/Snapshot" }),
          },
          "403": error("Forbidden"),
          "500": error("InternalError"),
        },
      },
    },
    "/api/capabilities": {
      get: {
        operationId: "getStudioCapabilities",
        summary: "Read optional Studio capabilities",
        tags: ["Observation"],
        responses: {
          "200": {
            description: "Capabilities enabled by the host process.",
            ...json({ $ref: "#/components/schemas/Capabilities" }),
          },
          "403": error("Forbidden"),
          "500": error("InternalError"),
        },
      },
    },
    "/api/runs/{runId}": {
      get: {
        operationId: "getStudioRun",
        summary: "Read one recorded run and its events",
        tags: ["Observation"],
        parameters: [parameter("runId", "Recorded pipeline run ID.")],
        responses: {
          "200": {
            description: "Projected run plus its stored events.",
            ...json({ $ref: "#/components/schemas/RunDetail" }),
          },
          "400": error("BadRequest"),
          "403": error("Forbidden"),
          "404": error("NotFound"),
          "500": error("InternalError"),
        },
      },
    },
    "/api/commands": {
      get: {
        operationId: "listStudioCommands",
        summary: "List explicitly registered commands",
        tags: ["Commands"],
        responses: {
          "200": {
            description: "Registered command descriptors.",
            ...json({ $ref: "#/components/schemas/CommandList" }),
          },
          "403": error("Forbidden"),
          "500": error("InternalError"),
        },
      },
    },
    "/api/commands/{commandId}/plan": {
      post: {
        operationId: "planStudioCommand",
        summary: "Preview selection for a registered command",
        tags: ["Commands"],
        parameters: [
          parameter("commandId", "Registered command ID."),
          guard("x-tubeless-studio-plan", "Same-origin request guard."),
        ],
        requestBody: {
          required: true,
          ...json({ $ref: "#/components/schemas/PlanInput" }),
        },
        responses: {
          "200": {
            description: "Selection-only pipeline plan. No steps have run.",
            ...json({ $ref: "#/components/schemas/PlanResult" }),
          },
          "400": error("BadRequest"),
          "403": error("Forbidden"),
          "405": error("CapabilityNotEnabled"),
          "413": error("PayloadTooLarge"),
          "415": error("GuardRequired"),
          "500": error("InternalError"),
        },
      },
    },
    "/api/commands/{commandId}/runs": {
      post: {
        operationId: "launchStudioCommand",
        summary: "Launch a registered command",
        description: "This operation can cause the side effects declared by the selected command.",
        tags: ["Commands"],
        parameters: [
          parameter("commandId", "Registered command ID."),
          guard("x-tubeless-studio-launch", "Same-origin request guard."),
        ],
        requestBody: {
          required: true,
          ...json({ $ref: "#/components/schemas/LaunchRequest" }),
        },
        responses: {
          "202": {
            description: "Launch accepted.",
            ...json({ $ref: "#/components/schemas/LaunchAccepted" }),
          },
          "400": error("BadRequest"),
          "403": error("Forbidden"),
          "404": error("NotFound"),
          "405": error("CapabilityNotEnabled"),
          "413": error("PayloadTooLarge"),
          "415": error("GuardRequired"),
          "500": error("InternalError"),
        },
      },
    },
    "/api/runs/{runId}/cancel": {
      post: {
        operationId: "cancelStudioRun",
        summary: "Cancel a live process-local launch",
        tags: ["Maintenance"],
        parameters: [
          parameter("runId", "Live pipeline run ID."),
          guard("x-tubeless-studio-cancel", "Same-origin request guard."),
        ],
        responses: {
          "202": {
            description: "Cancellation accepted.",
            ...json({ $ref: "#/components/schemas/CancelAccepted" }),
          },
          "400": error("BadRequest"),
          "403": error("Forbidden"),
          "404": error("NotFound"),
          "405": error("CapabilityNotEnabled"),
          "415": error("GuardRequired"),
          "500": error("InternalError"),
        },
      },
    },
    "/api/history": {
      delete: {
        operationId: "clearStudioHistory",
        summary: "Clear all recorded history",
        tags: ["Maintenance"],
        parameters: [
          guard("x-tubeless-studio-clear-history", "Same-origin request guard."),
        ],
        responses: {
          "200": {
            description: "History cleared.",
            ...json({ $ref: "#/components/schemas/ClearResult" }),
          },
          "403": error("Forbidden"),
          "405": error("CapabilityNotEnabled"),
          "409": error("Conflict"),
          "415": error("GuardRequired"),
          "500": error("InternalError"),
        },
      },
    },
  },
  components: {
    responses: Object.fromEntries(
      [
        ["BadRequest", "The request path or JSON body is invalid, or command validation rejected it."],
        ["Forbidden", "The Host header does not match the local Studio authority."],
        ["NotFound", "The requested command, run, or endpoint does not exist."],
        ["CapabilityNotEnabled", "The host process did not enable this capability."],
        ["Conflict", "The request conflicts with live Studio state."],
        ["GuardRequired", "A same-origin request guard or JSON content type is missing."],
        ["PayloadTooLarge", "The JSON request body exceeds 64 KiB."],
        ["InternalError", "The Studio encountered an unexpected local error."],
      ].map(([name, description]) => [
        name,
        { description, ...json({ $ref: "#/components/schemas/ErrorResponse" }) },
      ])
    ),
    schemas: {
      ErrorResponse: {
        type: "object",
        additionalProperties: false,
        required: ["code", "error", "hint", "message"],
        properties: {
          accepted: {
            const: false,
            type: "boolean",
            description: "Present when command validation rejected a launch.",
          },
          code: { type: "string", description: "Stable machine-readable error code." },
          error: {
            type: "string",
            description: "Backward-compatible alias of message.",
          },
          errors: {
            type: "array",
            description: "Validation failures present when code is launch_rejected.",
            items: { type: "string" },
          },
          hint: { type: "string", description: "Actionable recovery guidance." },
          message: { type: "string", description: "Human-readable error summary." },
        },
      },
      Capabilities: {
        type: "object",
        additionalProperties: false,
        required: ["canCancel", "canClearHistory"],
        properties: {
          canCancel: { type: "boolean" },
          canClearHistory: { type: "boolean" },
        },
      },
      Snapshot: {
        type: "object",
        additionalProperties: false,
        required: [
          "activeRunCount",
          "completedRunCount",
          "definitions",
          "failedRunCount",
          "generatedAtMs",
          "lastEventId",
          "liveRunIds",
          "runs",
        ],
        properties: {
          activeRunCount: { type: "integer", minimum: 0 },
          completedRunCount: { type: "integer", minimum: 0 },
          definitions: {
            type: "array",
            items: { $ref: "#/components/schemas/StoredPipelineDefinition" },
          },
          failedRunCount: { type: "integer", minimum: 0 },
          generatedAtMs: { type: "number" },
          lastEventId: { type: "integer", minimum: 0 },
          liveRunIds: { type: "array", items: { type: "string" } },
          runs: {
            type: "array",
            items: { $ref: "#/components/schemas/StoredPipelineRun" },
          },
        },
      },
      RunDetail: {
        type: "object",
        additionalProperties: false,
        required: ["events", "run"],
        properties: {
          events: {
            type: "array",
            items: { $ref: "#/components/schemas/StoredPipelineEvent" },
          },
          run: { $ref: "#/components/schemas/StoredPipelineRun" },
        },
      },
      StoredPipelineDefinition: {
        type: "object",
        additionalProperties: false,
        required: [
          "activeRuns",
          "firstSeenAtMs",
          "lastSeenAtMs",
          "pipelineId",
          "runCount",
          "steps",
          "targetIds",
        ],
        properties: {
          activeRuns: { type: "integer", minimum: 0 },
          firstSeenAtMs: { type: "number" },
          lastSeenAtMs: { type: "number" },
          pipelineId: { type: "string" },
          runCount: { type: "integer", minimum: 0 },
          steps: {
            type: "array",
            items: { $ref: "#/components/schemas/StoredPipelineDefinitionStep" },
          },
          targetIds: { type: "array", items: { type: "string" } },
        },
      },
      StoredPipelineDefinitionStep: {
        type: "object",
        additionalProperties: false,
        required: [
          "dependencies",
          "dryRun",
          "id",
          "optionalDependencies",
          "runtimeSkipPossible",
          "skipAfterFailureOf",
        ],
        properties: {
          dependencies: { type: "array", items: { type: "string" } },
          description: { type: "string" },
          dryRun: { type: "string" },
          id: { type: "string" },
          name: { type: "string" },
          nestedPipeline: { $ref: "#/components/schemas/StoredNestedPipeline" },
          optionalDependencies: { type: "array", items: { type: "string" } },
          remote: { $ref: "#/components/schemas/RemoteStep" },
          runtimeSkipPossible: { type: "boolean" },
          skipAfterFailureOf: { type: "array", items: { type: "string" } },
        },
      },
      StoredPipelineRun: {
        type: "object",
        additionalProperties: false,
        required: [
          "dryRun",
          "eventCount",
          "logCount",
          "logs",
          "pipelineId",
          "runId",
          "startedAtMs",
          "status",
          "steps",
          "version",
        ],
        properties: {
          correlationId: { type: "string" },
          dryRun: { type: "boolean" },
          durationMs: { type: "number" },
          error: { $ref: "#/components/schemas/PipelineError" },
          eventCount: { type: "integer", minimum: 0 },
          finishedAtMs: { type: "number" },
          logCount: { type: "integer", minimum: 0 },
          logs: {
            type: "array",
            items: { $ref: "#/components/schemas/StoredPipelineLog" },
          },
          parentRunId: { type: "string" },
          pipelineId: { type: "string" },
          runId: { type: "string" },
          startedAtMs: { type: "number" },
          status: {
            type: "string",
            enum: ["cancelled", "completed", "failed", "running"],
          },
          steps: {
            type: "array",
            items: { $ref: "#/components/schemas/StoredPipelineStep" },
          },
          version: { type: "integer", const: 2 },
        },
      },
      StoredPipelineStep: {
        type: "object",
        additionalProperties: false,
        required: ["id", "status"],
        properties: {
          attempt: { $ref: "#/components/schemas/StoredPipelineAttempt" },
          description: { type: "string" },
          durationMs: { type: "number" },
          finishedAtMs: { type: "number" },
          id: { type: "string" },
          name: { type: "string" },
          nestedPipeline: { $ref: "#/components/schemas/StoredNestedPipeline" },
          progress: { $ref: "#/components/schemas/StoredPipelineProgress" },
          remote: { $ref: "#/components/schemas/RemoteStep" },
          startedAtMs: { type: "number" },
          status: {
            type: "string",
            enum: ["cancelled", "completed", "failed", "planned", "running", "skipped"],
          },
        },
      },
      StoredPipelineAttempt: {
        type: "object",
        additionalProperties: false,
        required: ["attemptId", "retries", "startedAtMs", "status"],
        properties: {
          attemptId: { type: "string" },
          durationMs: { type: "number" },
          finishedAtMs: { type: "number" },
          retries: { type: "array", items: { type: "number" } },
          startedAtMs: { type: "number" },
          status: {
            type: "string",
            enum: ["cancelled", "completed", "failed", "running", "skipped"],
          },
        },
      },
      StoredPipelineProgress: {
        type: "object",
        additionalProperties: false,
        required: ["completed"],
        properties: {
          completed: { type: "number" },
          detailCount: { type: "number" },
          details: {
            type: "array",
            items: { $ref: "#/components/schemas/PipelineProgressDetail" },
          },
          message: { type: "string" },
          total: { type: "number" },
        },
      },
      PipelineProgressDetail: {
        type: "object",
        additionalProperties: false,
        required: ["id"],
        properties: {
          completed: { type: "number" },
          depth: { type: "number" },
          id: { type: "string" },
          label: { type: "string" },
          name: { type: "string" },
          status: {
            type: "string",
            enum: ["cancelled", "completed", "failed", "pending", "running", "skipped"],
          },
          total: { type: "number" },
        },
      },
      StoredPipelineLog: {
        type: "object",
        additionalProperties: false,
        required: ["id", "level", "message", "timestampMs"],
        properties: {
          attemptId: { type: "string" },
          id: { type: "integer", minimum: 0 },
          level: { type: "string", enum: ["error", "log", "warn"] },
          message: { type: "string" },
          stepId: { type: "string" },
          timestampMs: { type: "number" },
        },
      },
      StoredNestedPipeline: {
        type: "object",
        additionalProperties: false,
        required: ["mode", "pipelineId", "stepCount", "stepIds"],
        properties: {
          mode: { type: "string", enum: ["for-each", "single"] },
          pipelineId: { type: "string" },
          stepCount: { type: "integer", minimum: 0 },
          stepIds: { type: "array", items: { type: "string" } },
        },
      },
      PlannedNestedPipeline: {
        type: "object",
        additionalProperties: false,
        required: ["mode", "pipelineId", "stepIds"],
        properties: {
          mode: { type: "string", enum: ["for-each", "single"] },
          pipelineId: { type: "string" },
          stepIds: { type: "array", items: { type: "string" } },
        },
      },
      RemoteStep: {
        type: "object",
        additionalProperties: false,
        required: ["engine"],
        properties: {
          engine: { type: "string" },
          target: { type: "string" },
        },
      },
      StoredPipelineEvent: {
        type: "object",
        additionalProperties: false,
        required: [
          "attributes",
          "id",
          "name",
          "pipelineId",
          "runId",
          "timestampMs",
          "version",
        ],
        properties: {
          attributes: {
            type: "object",
            additionalProperties: {
              oneOf: [{ type: "boolean" }, { type: "number" }, { type: "string" }],
            },
          },
          attemptId: { type: "string" },
          correlationId: { type: "string" },
          durationMs: { type: "number" },
          error: { $ref: "#/components/schemas/PipelineError" },
          id: { type: "integer", minimum: 0 },
          itemKey: { type: "string" },
          name: {
            type: "string",
            enum: [
              "pipeline.completed",
              "pipeline.finalize.completed",
              "pipeline.finalize.failed",
              "pipeline.finalize.started",
              "pipeline.log",
              "pipeline.started",
              "step.attempted",
              "step.cancelled",
              "step.complete",
              "step.failed",
              "step.planned",
              "step.running",
              "step.skipped",
            ],
          },
          parentRunId: { type: "string" },
          pipelineId: { type: "string" },
          runId: { type: "string" },
          stepId: { type: "string" },
          timestampMs: { type: "number" },
          version: { type: "integer", const: 1 },
        },
      },
      PipelineError: {
        type: "object",
        additionalProperties: false,
        required: ["code", "kind", "message", "phase"],
        properties: {
          cause: { $ref: "#/components/schemas/PipelineErrorCause" },
          code: { type: "string" },
          fanOut: { $ref: "#/components/schemas/PipelineFanOutDiagnostics" },
          issues: {
            type: "array",
            items: { $ref: "#/components/schemas/PipelineValidationIssue" },
          },
          kind: {
            type: "string",
            enum: [
              "cancellation",
              "child",
              "definition",
              "finalization",
              "selection",
              "step",
              "validation",
            ],
          },
          message: { type: "string" },
          phase: {
            type: "string",
            enum: ["definition", "execution", "finalization", "planning"],
          },
          sourceCode: { type: "string" },
          stack: { type: "string" },
          stepId: { type: "string" },
        },
      },
      PipelineErrorCause: {
        type: "object",
        additionalProperties: false,
        required: ["message"],
        properties: {
          cause: { $ref: "#/components/schemas/PipelineErrorCause" },
          message: { type: "string" },
          name: { type: "string" },
          sourceCode: { type: "string" },
        },
      },
      PipelineValidationIssue: {
        type: "object",
        additionalProperties: false,
        required: ["message"],
        properties: {
          message: { type: "string" },
          path: {
            type: "array",
            items: { oneOf: [{ type: "integer" }, { type: "string" }] },
          },
        },
      },
      PipelineFanOutDiagnostics: {
        type: "object",
        additionalProperties: false,
        required: ["failureCount", "failures", "omittedFailureCount"],
        properties: {
          failureCount: { type: "integer", minimum: 0 },
          failures: {
            type: "array",
            items: { $ref: "#/components/schemas/PipelineFanOutFailure" },
          },
          omittedFailureCount: { type: "integer", minimum: 0 },
          schedulerError: { $ref: "#/components/schemas/PipelineErrorCause" },
        },
      },
      PipelineFanOutFailure: {
        type: "object",
        additionalProperties: false,
        required: ["cancelled", "error", "index", "key", "keyTruncated"],
        properties: {
          cancelled: { type: "boolean" },
          error: { $ref: "#/components/schemas/PipelineErrorCause" },
          index: { type: "integer", minimum: 0 },
          key: { type: "string" },
          keyTruncated: { type: "boolean" },
        },
      },
      CommandList: {
        type: "object",
        additionalProperties: false,
        required: ["commands"],
        properties: {
          commands: {
            type: "array",
            items: { $ref: "#/components/schemas/Command" },
          },
        },
      },
      Command: {
        type: "object",
        additionalProperties: false,
        required: ["canPlan", "id", "name", "parameters"],
        properties: {
          canPlan: { type: "boolean" },
          description: { type: "string" },
          id: { type: "string" },
          name: { type: "string" },
          parameters: { type: "array", items: { type: "object" } },
        },
      },
      PlanInput: {
        type: "object",
        additionalProperties: false,
        properties: {
          dryRun: { type: "boolean" },
          stepIds: {
            type: "array",
            maxItems: 128,
            items: { type: "string", maxLength: 4096 },
          },
          targets: {
            type: "array",
            maxItems: 128,
            items: { type: "string", maxLength: 4096 },
          },
        },
      },
      PlanResult: {
        type: "object",
        additionalProperties: false,
        required: ["plan"],
        properties: { plan: { $ref: "#/components/schemas/PipelinePlan" } },
      },
      PipelinePlan: {
        type: "object",
        additionalProperties: false,
        required: ["dryRun", "errors", "ok", "pipelineId", "steps"],
        properties: {
          dryRun: { type: "boolean" },
          errors: {
            type: "array",
            items: { $ref: "#/components/schemas/PipelineError" },
          },
          ok: { type: "boolean" },
          pipelineId: { type: "string" },
          steps: {
            type: "array",
            items: { $ref: "#/components/schemas/PipelinePlanStep" },
          },
        },
      },
      PipelinePlanStep: {
        type: "object",
        additionalProperties: false,
        required: [
          "dependencies",
          "dryRun",
          "id",
          "optionalDependencies",
          "runtimeSkipPossible",
          "selected",
          "selectionReasons",
          "skipAfterFailureOf",
        ],
        properties: {
          dependencies: { type: "array", items: { type: "string" } },
          description: { type: "string" },
          dryRun: { type: "string", enum: ["custom", "run", "skip"] },
          id: { type: "string" },
          name: { type: "string" },
          nestedPipeline: { $ref: "#/components/schemas/PlannedNestedPipeline" },
          optionalDependencies: { type: "array", items: { type: "string" } },
          remote: { $ref: "#/components/schemas/RemoteStep" },
          runtimeSkipPossible: { type: "boolean" },
          selected: { type: "boolean" },
          selectionReasons: {
            type: "array",
            items: { $ref: "#/components/schemas/PipelineStepSelectionReason" },
          },
          skipAfterFailureOf: { type: "array", items: { type: "string" } },
          skipReason: {
            type: "string",
            enum: [
              "dry-run",
              "failed-dependency",
              "fail-fast",
              "filtered",
              "policy",
              "unmet-dependency",
            ],
          },
        },
      },
      PipelineStepSelectionReason: {
        oneOf: [
          {
            type: "object",
            additionalProperties: false,
            required: ["kind"],
            properties: {
              kind: {
                type: "string",
                enum: ["all", "exact", "not-selected", "outside-target-closure"],
              },
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["kind", "targetId"],
            properties: {
              kind: { type: "string", const: "target" },
              targetId: { type: "string" },
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["dependentId", "kind", "targetId"],
            properties: {
              dependentId: { type: "string" },
              kind: {
                type: "string",
                enum: ["failure-gate", "optional-only", "required-dependency"],
              },
              targetId: { type: "string" },
            },
          },
        ],
      },
      LaunchRequest: {
        type: "object",
        additionalProperties: false,
        required: ["values"],
        properties: {
          values: {
            type: "object",
            maxProperties: 128,
            propertyNames: { type: "string", minLength: 1, maxLength: 4096 },
            additionalProperties: {
              anyOf: [
                { type: "boolean" },
                { type: "number" },
                { type: "string", maxLength: 4096 },
                {
                  type: "array",
                  maxItems: 128,
                  items: { type: "number" },
                },
                {
                  type: "array",
                  maxItems: 128,
                  items: { type: "string", maxLength: 4096 },
                },
              ],
            },
          },
        },
      },
      LaunchAccepted: {
        type: "object",
        additionalProperties: false,
        required: ["accepted", "runId"],
        properties: {
          accepted: { const: true, type: "boolean" },
          runId: { type: "string" },
        },
      },
      CancelAccepted: {
        type: "object",
        additionalProperties: false,
        required: ["cancelled", "runId"],
        properties: {
          cancelled: { const: true, type: "boolean" },
          runId: { type: "string" },
        },
      },
      ClearResult: {
        type: "object",
        additionalProperties: false,
        required: ["cleared", "eventCount", "runCount"],
        properties: {
          cleared: { const: true, type: "boolean" },
          eventCount: { type: "integer", minimum: 0 },
          runCount: { type: "integer", minimum: 0 },
        },
      },
    },
  },
  "x-tubeless-hosted-api": false,
  "x-tubeless-spec-url": absUrl("openapi.json"),
} as const;

export const GET: APIRoute = () =>
  new Response(`${JSON.stringify(spec, null, 2)}\n`, {
    headers: {
      "cache-control": "public, max-age=300",
      "content-type": "application/json; charset=utf-8",
    },
  });
