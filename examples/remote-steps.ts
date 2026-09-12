import {
  createSteps,
  definePipeline,
  requireOutputs,
  type RemoteStepAdapter,
  type StandardSchemaV1,
} from "tubeless";

interface RemoteStepsOptions {
  endpoint: string;
  lines: readonly string[];
}

interface EnrichResult {
  readonly orderId: string;
  readonly rows: readonly string[];
}

// This schema is the I/O boundary: inspect untrusted JSON before returning a domain value.
/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters */
const enrichSchema: StandardSchemaV1<unknown, EnrichResult> = {
  "~standard": {
    vendor: "example",
    version: 1,
    validate(value) {
      if (
        typeof value === "object" &&
        value !== null &&
        "orderId" in value &&
        typeof value.orderId === "string" &&
        "rows" in value &&
        Array.isArray(value.rows) &&
        value.rows.every((row: unknown) => typeof row === "string")
      ) {
        return { value: { orderId: value.orderId, rows: value.rows } };
      }
      return { issues: [{ message: "Expected { orderId: string, rows: string[] }" }] };
    },
  },
};

/* oxlint-enable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters */

interface RemotePayload {
  dryRun: boolean;
  rows: readonly string[];
  runId: string;
}

// Application-owned HTTP protocol, using native fetch. No provider SDK is needed.
const enrichAdapter: RemoteStepAdapter<RemoteStepsOptions, RemotePayload, unknown> = {
  engine: "http",
  target: "POST /enrich",
  async invoke(payload, context) {
    const response = await fetch(new URL("/enrich", context.options.endpoint), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: context.signal,
    });
    if (!response.ok) {
      // Status remains actionable even for an HTML or empty error body. Limit
      // diagnostics to status; do not copy potentially sensitive response bodies.
      await response.body?.cancel();
      throw Object.assign(new Error(`Remote enrichment failed: HTTP ${response.status}`), {
        code: `HTTP_${response.status}`,
        cause: new Error(`HTTP ${response.status} ${response.statusText}`),
      });
    }
    // Malformed JSON throws; well-formed but invalid data reaches outputSchema.
    const result: unknown = await response.json();
    return result;
  },
};

const step = createSteps<RemoteStepsOptions>();
const parse = step("parse", {
  description: "Trim input rows before sending them to the remote service",
  run: (_inputs, context) =>
    context.options.lines.map((line) => line.trim()).filter((line) => line.length > 0),
});
const enrich = step.fromRemote("enrich", {
  description: "Validate the HTTP service result before local consumption",
  dependsOn: [parse],
  adapter: enrichAdapter,
  mapInput: ({ parse }, ctx) => ({ rows: parse, runId: ctx.runId, dryRun: ctx.dryRun }),
  outputSchema: enrichSchema,
  // Omitted intentionally: the service must honor dryRun without side effects.
});
const summarize = step("summarize", {
  description: "Consume only validated remote rows",
  dependsOn: [enrich],
  run: ({ enrich }) => ({ orderId: enrich.orderId, count: enrich.rows.length }),
});

export const RemoteStepsPipeline = definePipeline({
  id: "remote-steps",
  steps: [parse, enrich, summarize],
  targets: [summarize],
  finalize: requireOutputs([summarize], ({ summarize }) => summarize),
});

export async function runRemoteStepsExample(endpoint: string) {
  return RemoteStepsPipeline.runOrThrow({ endpoint, lines: [" Alpha ", "", "Beta"] });
}
