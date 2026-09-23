import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createSteps, definePipeline, type RemoteStepAdapter } from "tubeless";
import { definePipelineCommand } from "tubeless/cli";
import { requireEnv } from "tubeless/node";
import { airflowResultSchema, isRecord } from "./contract.js";

interface AirflowOptions {
  apiUrl: string;
  requestId: string;
  lines: readonly string[];
  pollIntervalMs?: number;
  timeoutMs?: number;
}

interface AirflowPayload {
  request_id: string;
  lines: readonly string[];
  tubeless_parent_run_id: string;
  dry_run: boolean;
}

const dagId = "tubeless_example";
const taskId = "normalize";

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}

// Airflow 3 public API only. Credentials are read at execution time, never
// included in pipeline options, plans, DAG conf, or diagnostic response bodies.
const airflowAdapter: RemoteStepAdapter<AirflowOptions, AirflowPayload, unknown> = {
  engine: "airflow",
  target: dagId,
  async invoke(payload, context) {
    if (context.dryRun) fail("AIRFLOW_DRY_RUN", "Airflow submission is disabled in dry runs");
    if (!payload.request_id.trim()) fail("AIRFLOW_REQUEST_ID", "Supply a stable request ID");
    const pollMs = context.options.pollIntervalMs ?? 1000;
    const timeoutMs = context.options.timeoutMs ?? 120_000;
    if (![pollMs, timeoutMs].every((n) => Number.isSafeInteger(n) && n > 0 && n <= 2_147_483_647)) {
      fail("AIRFLOW_WAIT_CONFIG", "Polling and timeout must be positive millisecond integers");
    }
    const base = new URL(context.options.apiUrl.replace(/\/?$/, "/"));
    if (
      !/^https?:$/.test(base.protocol) ||
      base.username ||
      base.password ||
      base.search ||
      base.hash
    ) {
      fail(
        "AIRFLOW_API_URL",
        "Use an HTTP(S) API base URL without credentials, query, or fragment"
      );
    }
    const token = requireEnv("AIRFLOW_TOKEN", "Airflow example");
    const signal = AbortSignal.any([
      ...(context.signal ? [context.signal] : []),
      AbortSignal.timeout(timeoutMs),
    ]);
    // One business request owns one Airflow run, even across new local executions.
    const runId = `tubeless__${createHash("sha256").update(payload.request_id).digest("hex")}`;
    const runsPath = `dags/${encodeURIComponent(dagId)}/dagRuns`;
    const runPath = `${runsPath}/${encodeURIComponent(runId)}`;
    context.log.log(`Airflow ${dagId} / ${runId}`);

    async function request(path: string, body?: unknown): Promise<Response> {
      const response = await fetch(new URL(path, base), {
        method: body === undefined ? "GET" : "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
        redirect: "error",
      });
      if (!response.ok && !(body !== undefined && response.status === 409)) {
        await response.body?.cancel().catch(() => {});
        fail(`AIRFLOW_HTTP_${response.status}`, `Airflow returned HTTP ${response.status}`);
      }
      return response;
    }

    const submitted = await request(runsPath, {
      dag_run_id: runId,
      logical_date: null,
      conf: payload,
    });
    // A 409 means inspect the existing run; it never means clear or rerun it.
    await submitted.body?.cancel();
    for (;;) {
      signal.throwIfAborted();
      const run: unknown = await (await request(runPath)).json();
      if (!isRecord(run) || run.dag_run_id !== runId || !isRecord(run.conf)) {
        fail("AIRFLOW_RUN_RESPONSE", "Airflow returned an invalid run identity or conf");
      }
      // Parent execution IDs may differ on reattachment; business inputs may not.
      if (
        run.conf.request_id !== payload.request_id ||
        run.conf.dry_run !== payload.dry_run ||
        JSON.stringify(run.conf.lines) !== JSON.stringify(payload.lines)
      ) {
        fail("AIRFLOW_REQUEST_CONFLICT", "Existing Airflow run belongs to different inputs");
      }
      const state = run.state;
      context.reportProgress({ completed: 0, message: `Airflow ${runId}: ${String(state)}` });
      if (state === "failed") fail("AIRFLOW_DAG_FAILED", `Airflow run ${runId} failed`);
      if (state === "success") break;
      if (state !== "queued" && state !== "running") {
        fail("AIRFLOW_RUN_STATE", "Airflow returned an unknown DAG run state");
      }
      await context.sleep(pollMs, signal);
    }
    const xcom: unknown = await (
      await request(
        `${runPath}/taskInstances/${taskId}/xcomEntries/return_value?map_index=-1&stringify=false`
      )
    ).json();
    if (!isRecord(xcom) || !("value" in xcom)) fail("AIRFLOW_XCOM", "Missing XCom value");
    return xcom.value; // fromRemote's outputSchema validates before local consumers run.
  },
};

const { fromRemote, step } = createSteps<AirflowOptions>();
const normalize = fromRemote("normalize-in-airflow", {
  description: "Submit or reattach to an Airflow run and validate its Tubeless result",
  adapter: airflowAdapter,
  mapInput: (_inputs, context) => ({
    request_id: context.options.requestId,
    lines: context.options.lines,
    tubeless_parent_run_id: context.runId,
    dry_run: context.dryRun,
  }),
  outputSchema: airflowResultSchema,
  dryRun: "skip", // Airflow has no generic side-effect-free trigger operation.
});
const summarize = step("summarize", {
  dependsOn: [normalize],
  run: ({ "normalize-in-airflow": result }, context) => {
    context.log.log(`Received ${result.count} rows from Tubeless run ${result.runId}`);
    return result;
  },
});

export const AirflowRemotePipeline = definePipeline({
  id: "airflow-remote",
  steps: [normalize, summarize],
});

export const AirflowRemoteCommand = definePipelineCommand(AirflowRemotePipeline, {
  params: {
    apiUrl: { type: "string", description: "Airflow 3 API base, including /api/v2/" },
    requestId: {
      type: "string",
      description: "Stable business request ID; reuse only for identical inputs",
    },
    source: {
      type: "path",
      mustExist: true,
      kind: "file",
      description: "Text file with one row per line",
    },
    timeoutMs: {
      type: "number",
      optional: true,
      integer: true,
      min: 1,
      description: "Maximum total wait in milliseconds (default 120000)",
    },
  },
  mapOptions: (args) => ({
    apiUrl: args.apiUrl,
    requestId: args.requestId,
    lines: readFileSync(args.source, "utf8").split("\n"),
    timeoutMs: args.timeoutMs,
  }),
});
