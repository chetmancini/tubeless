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
          "400": {
            description: "Invalid values or a launch rejected by command validation.",
            ...json({
              oneOf: [
                { $ref: "#/components/schemas/ErrorResponse" },
                { $ref: "#/components/schemas/LaunchRejected" },
              ],
            }),
          },
          "403": error("Forbidden"),
          "404": error("NotFound"),
          "405": error("CapabilityNotEnabled"),
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
        ["BadRequest", "The request path or JSON body is invalid."],
        ["Forbidden", "The Host header does not match the local Studio authority."],
        ["NotFound", "The requested command, run, or endpoint does not exist."],
        ["CapabilityNotEnabled", "The host process did not enable this capability."],
        ["Conflict", "The request conflicts with live Studio state."],
        ["GuardRequired", "A same-origin request guard or JSON content type is missing."],
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
          code: { type: "string", description: "Stable machine-readable error code." },
          error: {
            type: "string",
            description: "Backward-compatible alias of message.",
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
        required: ["activeRunCount", "completedRunCount", "liveRunIds", "runs"],
        properties: {
          activeRunCount: { type: "integer", minimum: 0 },
          completedRunCount: { type: "integer", minimum: 0 },
          liveRunIds: { type: "array", items: { type: "string" } },
          runs: { type: "array", items: { type: "object" } },
        },
        additionalProperties: true,
      },
      RunDetail: {
        type: "object",
        additionalProperties: false,
        required: ["events", "run"],
        properties: {
          events: { type: "array", items: { type: "object" } },
          run: { type: "object" },
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
        properties: { plan: { type: "object" } },
      },
      LaunchRequest: {
        type: "object",
        additionalProperties: false,
        required: ["values"],
        properties: {
          values: {
            type: "object",
            maxProperties: 128,
            additionalProperties: {
              oneOf: [
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
      LaunchRejected: {
        type: "object",
        additionalProperties: false,
        required: ["accepted", "code", "error", "errors", "hint", "message"],
        properties: {
          accepted: { const: false, type: "boolean" },
          code: { const: "launch_rejected", type: "string" },
          error: { type: "string" },
          errors: { type: "array", items: { type: "string" } },
          hint: { type: "string" },
          message: { type: "string" },
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
