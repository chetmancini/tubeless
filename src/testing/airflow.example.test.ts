import { createServer, type IncomingMessage } from "node:http";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AirflowRemotePipeline } from "../../examples/airflow/remote.js";
import { runAirflowJob } from "../../examples/airflow/hosted.js";
import type { PipelineTraceEvent } from "tubeless/tracing";

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        })
    )
  );
});

async function readBody(request: IncomingMessage) {
  let text = "";
  for await (const chunk of request) text += String(chunk);
  return JSON.parse(text);
}

const hostedJob = {
  dagId: "tubeless_example",
  dagRunId: "manual__example",
  taskId: "normalize",
  mapIndex: -1,
  tryNumber: 1,
  conf: { lines: [" Alpha ", "", "Beta"], dry_run: false, tubeless_parent_run_id: "parent:run-1" },
};

async function airflow(
  settings: {
    states?: string[];
    conflict?: boolean;
    changedInput?: boolean;
    result?: unknown;
    status?: number;
    hang?: boolean;
    onPoll?: () => void;
  } = {}
) {
  const requests: { method?: string; url?: string; auth?: string }[] = [];
  const submissions: Record<string, unknown>[] = [];
  let polls = 0;
  const server = createServer(async (request, response) => {
    requests.push({
      method: request.method,
      url: request.url,
      auth: request.headers.authorization,
    });
    response.setHeader("content-type", "application/json");
    if (settings.status) {
      response.writeHead(settings.status).end("sensitive error body");
      return;
    }
    if (request.method === "POST") {
      submissions.push(await readBody(request));
      response.writeHead(settings.conflict ? 409 : 200).end("{}");
      return;
    }
    if (request.url?.includes("/xcomEntries/")) {
      const result = "result" in settings ? settings.result : await runAirflowJob(hostedJob);
      response.end(JSON.stringify({ value: result }));
      return;
    }
    settings.onPoll?.();
    if (settings.hang) return;
    const submission = submissions[0];
    response.end(
      JSON.stringify({
        ...submission,
        conf: settings.changedInput
          ? { request_id: "another-request", lines: [], dry_run: false }
          : submission.conf,
        state: settings.states?.[polls++] ?? "success",
      })
    );
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP address");
  vi.stubEnv("AIRFLOW_TOKEN", "test-token");
  return {
    requests,
    submissions,
    options: {
      apiUrl: `http://127.0.0.1:${address.port}/airflow/api/v2/`,
      requestId: "import-42",
      lines: hostedJob.conf.lines,
      pollIntervalMs: 1,
    },
  };
}

describe("Airflow remote recipe", () => {
  it("submits, reports queued/running states, and consumes a validated hosted result", async () => {
    const service = await airflow({ states: ["queued", "running", "success"] });
    const events: PipelineTraceEvent[] = [];
    const progress: unknown[] = [];
    const result = await AirflowRemotePipeline.runOrThrow(service.options, undefined, {
      tracing: {
        exporter: {
          export: (event) => {
            events.push(event);
          },
        },
      },
      hooks: {
        onStepProgress: (event) => {
          progress.push(event);
        },
      },
    });
    expect(result).toMatchObject({ rows: ["alpha", "beta"], count: 2, preview: false });
    expect(service.submissions).toEqual([
      {
        dag_run_id: expect.stringMatching(/^tubeless__[a-f0-9]{64}$/),
        logical_date: null,
        conf: {
          request_id: "import-42",
          lines: hostedJob.conf.lines,
          dry_run: false,
          tubeless_parent_run_id: expect.stringMatching(/^airflow-remote:/),
        },
      },
    ]);
    expect(service.requests.every((request) => request.auth === "Bearer test-token")).toBe(true);
    expect(service.requests[0].url).toBe("/airflow/api/v2/dags/tubeless_example/dagRuns");
    expect(service.requests.at(-1)?.url).toContain(
      "/taskInstances/normalize/xcomEntries/return_value?map_index=-1&stringify=false"
    );
    expect(progress).toHaveLength(3);
    expect(JSON.stringify(events)).not.toContain("test-token");
  });

  it("reattaches after 409 with the same request identity across local executions", async () => {
    const service = await airflow({ conflict: true });
    await AirflowRemotePipeline.runOrThrow(service.options);
    await AirflowRemotePipeline.runOrThrow(service.options);
    expect(service.submissions[0].dag_run_id).toBe(service.submissions[1].dag_run_id);
    expect(service.submissions[0].conf).not.toEqual(service.submissions[1].conf);
    expect(
      service.requests.every(
        (request) => request.method === "GET" || request.url?.endsWith("/dagRuns")
      )
    ).toBe(true);
  });

  it("rejects reuse of a request ID for different inputs", async () => {
    const service = await airflow({ conflict: true, changedInput: true });
    const run = await AirflowRemotePipeline.run(service.options);
    expect(run.errors[0].sourceCode).toBe("AIRFLOW_REQUEST_CONFLICT");
    expect(service.requests).toHaveLength(2);
  });

  it("does not require credentials or make requests in a dry run", async () => {
    const service = await airflow();
    vi.stubEnv("AIRFLOW_TOKEN", undefined);
    const run = await AirflowRemotePipeline.run(service.options, { dryRun: true });
    expect(run.status).toBe("completed");
    expect(run.steps.every((step) => step.status === "skipped")).toBe(true);
    expect(service.requests).toEqual([]);
  });

  it.each(["failed", "unexpected"])("blocks downstream work for state %s", async (state) => {
    const service = await airflow({ states: [state] });
    const run = await AirflowRemotePipeline.run(service.options);
    expect(run.status).toBe("failed");
    expect(run.errors[0].sourceCode).toBe(
      state === "failed" ? "AIRFLOW_DAG_FAILED" : "AIRFLOW_RUN_STATE"
    );
    expect(run.steps.find((step) => step.id === "summarize")?.status).toBe("skipped");
    expect(service.requests).toHaveLength(2);
  });

  it.each([
    null,
    { rows: [42], count: 1, runId: "r", preview: false },
    { rows: [], count: 2, runId: "r", preview: false },
  ])("validates native XCom data before consumption: %j", async (result) => {
    const service = await airflow({ result });
    const run = await AirflowRemotePipeline.run(service.options);
    expect(run.errors[0]).toMatchObject({ kind: "validation", stepId: "normalize-in-airflow" });
    expect(run.steps.find((step) => step.id === "summarize")?.status).toBe("skipped");
  });

  it("keeps HTTP status without exposing response bodies", async () => {
    const service = await airflow({ status: 403 });
    const run = await AirflowRemotePipeline.run(service.options);
    expect(run.errors[0].sourceCode).toBe("AIRFLOW_HTTP_403");
    expect(JSON.stringify(run)).not.toContain("sensitive error body");
  });

  it("cancels an in-flight poll without sending a remote mutation", async () => {
    const controller = new AbortController();
    const service = await airflow({ hang: true, onPoll: () => controller.abort() });
    const run = await AirflowRemotePipeline.run(service.options, undefined, {
      signal: controller.signal,
    });
    expect(run.status).toBe("cancelled");
    expect(service.requests.map((request) => request.method)).toEqual(["POST", "GET"]);
  });

  it("bounds a stalled HTTP request with the overall timeout", async () => {
    const service = await airflow({ hang: true });
    const run = await AirflowRemotePipeline.run({ ...service.options, timeoutMs: 100 });
    expect(run.status).toBe("failed");
    expect(run.steps.find((step) => step.id === "summarize")?.status).toBe("skipped");
  });
});

describe("Airflow hosted recipe", () => {
  it("correlates retries while assigning new Tubeless executions", async () => {
    const events: PipelineTraceEvent[] = [];
    const exporter = {
      export: (event: PipelineTraceEvent) => {
        events.push(event);
      },
    };
    const first = await runAirflowJob(hostedJob, undefined, exporter);
    const second = await runAirflowJob({ ...hostedJob, tryNumber: 2 }, undefined, exporter);
    expect(first.runId).not.toBe(second.runId);
    const starts = events.filter((event) => event.name === "pipeline.started");
    expect(starts).toHaveLength(2);
    expect(starts[0].correlationId).toBe(starts[1].correlationId);
    expect(starts[0].parentRunId).toBe("parent:run-1");
  });

  it("supports standalone Airflow invocation and dry-run controls", async () => {
    const events: PipelineTraceEvent[] = [];
    const result = await runAirflowJob(
      { ...hostedJob, conf: { lines: [" A "], dry_run: true } },
      undefined,
      {
        export: (event) => {
          events.push(event);
        },
      }
    );
    expect(result).toMatchObject({ rows: ["a"], count: 1, preview: true });
    expect(events[0].parentRunId).toBeUndefined();
  });

  it("rejects malformed jobs and cancellation back to the host", async () => {
    await expect(runAirflowJob({ ...hostedJob, conf: { lines: [42] } })).rejects.toThrow(
      "Invalid Airflow task envelope"
    );
    await expect(runAirflowJob(hostedJob, AbortSignal.abort())).rejects.toThrow();
  });

  it("runs the real worker with stdin, structured logs, and a success-only result file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "airflow-example-"));
    try {
      const resultPath = join(directory, "result.json");
      const child = spawnSync("bun", ["run", "examples/airflow/worker.ts"], {
        input: JSON.stringify(hostedJob),
        encoding: "utf8",
        timeout: 10_000,
        env: { ...process.env, TUBELESS_RESULT_PATH: resultPath },
      });
      expect(child.status, child.stderr).toBe(0);
      expect(JSON.parse(await readFile(resultPath, "utf8"))).toMatchObject({
        rows: ["alpha", "beta"],
        count: 2,
      });
      expect(child.stdout).toContain('"pipeline.completed"');
      const failurePath = join(directory, "failed.json");
      const failed = spawnSync("bun", ["run", "examples/airflow/worker.ts"], {
        input: JSON.stringify({ ...hostedJob, conf: { lines: [42] } }),
        encoding: "utf8",
        timeout: 10_000,
        env: { ...process.env, TUBELESS_RESULT_PATH: failurePath },
      });
      expect(failed.status).not.toBe(0);
      await expect(readFile(failurePath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
