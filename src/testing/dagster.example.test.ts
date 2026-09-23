import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { DagsterPipeline } from "../../examples/dagster/pipeline.js";

const directories: string[] = [];
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "tubeless-dagster-"));
  directories.push(directory);
  return {
    lines: [" Alpha ", "", "Beta", "ALPHA"],
    outputPath: join(directory, "rows.json"),
    tracePath: join(directory, "trace.ndjson"),
  };
}

const encode = (value: unknown) => deflateSync(JSON.stringify(value)).toString("base64");
function environment(job: unknown, retry = 0) {
  return {
    ...process.env,
    DAGSTER_PIPES_CONTEXT: encode({
      data: {
        asset_keys: ["normalized_rows"],
        run_id: "dagster-run-1",
        retry_number: retry,
        extras: { job },
      },
    }),
    DAGSTER_PIPES_MESSAGES: encode({ stdio: "stdout" }),
  };
}

// Exercise the real SDK's wire protocol in a fresh process (Pipes is a singleton).
function messages(stdout: string) {
  return stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
function execute(job: unknown, retry = 0) {
  const child = spawnSync("bun", ["run", "examples/dagster/worker.ts"], {
    env: environment(job, retry),
    encoding: "utf8",
    timeout: 10_000,
  });
  expect(child.error).toBeUndefined();
  const events = messages(child.stdout);
  return {
    status: child.status,
    events,
    materializations: events.filter((event) => event.method === "report_asset_materialization"),
    traces: events
      .filter((event) => event.method === "report_custom_message")
      .map((event) => event.params.payload.event),
  };
}

describe("Dagster Pipes recipe", () => {
  it("publishes an artifact and reports content identity, progress, and correlated traces", () => {
    const job = fixture();
    const result = execute({ ...job, parentRunId: "parent:execution-1" });
    expect(result.status).toBe(0);
    expect(JSON.parse(readFileSync(job.outputPath, "utf8"))).toEqual({ rows: ["alpha", "beta"] });
    expect(result.materializations).toHaveLength(1);
    expect(result.materializations[0].params).toMatchObject({
      asset_key: "normalized_rows",
      data_version: createHash("sha256")
        .update(JSON.stringify(["alpha", "beta"]))
        .digest("hex"),
      metadata: {
        row_count: { raw_value: 2, type: "int" },
        artifact: { raw_value: job.outputPath, type: "path" },
        tubeless_trace: { raw_value: job.tracePath, type: "path" },
      },
    });
    expect(result.traces).toContainEqual(
      expect.objectContaining({
        name: "pipeline.started",
        parentRunId: "parent:execution-1",
        correlationId: JSON.stringify(["dagster", "dagster-run-1", "normalized_rows"]),
      })
    );
    expect(result.traces).toContainEqual(expect.objectContaining({ name: "pipeline.completed" }));
    expect(result.events).toContainEqual(
      expect.objectContaining({
        method: "log",
        params: expect.objectContaining({ message: "normalize: 4/4" }),
      })
    );
    expect(result.events.at(-1)?.method).toBe("closed");
  });

  it("keeps the data version and correlation stable across retries with fresh Tubeless run IDs", () => {
    const job = fixture();
    const first = execute(job);
    const second = execute(job, 1);
    expect(first.status).toBe(0);
    expect(second.status).toBe(0);
    const a = first.traces.find((event) => event.name === "pipeline.started");
    const b = second.traces.find((event) => event.name === "pipeline.started");
    expect(a.correlationId).toBe(b.correlationId);
    expect(a.runId).not.toBe(b.runId);
    expect(a).not.toHaveProperty("parentRunId");
    expect(first.materializations[0].params.data_version).toBe(
      second.materializations[0].params.data_version
    );
    expect(JSON.parse(readFileSync(job.outputPath, "utf8"))).toEqual({ rows: ["alpha", "beta"] });
  });

  it("previews locally without replacing an existing artifact", async () => {
    const job = fixture();
    writeFileSync(job.outputPath, "existing dataset");
    const result = await DagsterPipeline.runOrThrow(job, { dryRun: true });
    expect(result.preview).toBe(true);
    expect(result.rowCount).toBe(2);
    expect(readFileSync(job.outputPath, "utf8")).toBe("existing dataset");
  });

  it("fails validation before publication and exits unsuccessfully", () => {
    const job = fixture();
    const result = execute({ ...job, lines: [" "] });
    expect(result.status).not.toBe(0);
    expect(result.materializations).toEqual([]);
    expect(existsSync(job.outputPath)).toBe(false);
    expect(result.events.at(-1)).toMatchObject({
      method: "closed",
      params: { exception: expect.anything() },
    });
  });

  it.each([
    null,
    { lines: [42] },
    { dryRun: "true" },
    { dryRun: true },
    { outputPath: "relative.json" },
    { parentRunId: 42 },
  ])("rejects malformed host input %j", (invalid) => {
    const job = fixture();
    const result = execute(invalid === null ? null : { ...job, ...invalid });
    expect(result.status).not.toBe(0);
    expect(result.materializations).toEqual([]);
    expect(existsSync(job.outputPath)).toBe(false);
  });

  it("rejects launching without a Dagster Pipes context", () => {
    const env = { ...process.env };
    delete env.DAGSTER_PIPES_CONTEXT;
    delete env.DAGSTER_PIPES_MESSAGES;
    const child = spawnSync("bun", ["run", "examples/dagster/worker.ts"], {
      env,
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(child.status).not.toBe(0);
    expect(child.stderr).toContain("DAGSTER_PIPES_CONTEXT");
  });

  it("cooperatively aborts on host termination before publishing", async () => {
    const job = fixture();
    const child = spawn("bun", ["run", "examples/dagster/worker.ts"], {
      env: environment({ ...job, lines: Array.from({ length: 1000 }, () => "alpha") }),
      stdio: ["ignore", "pipe", "ignore"],
    });
    let stdout = "";
    let cancelled = false;
    child.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
      if (!cancelled && stdout.includes("normalize: 1/1000")) {
        cancelled = true;
        child.kill("SIGTERM");
      }
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 8000);
    try {
      const exit = await new Promise<{ code: number | null; signal: string | null }>(
        (resolve, reject) => {
          child.once("error", reject);
          child.once("close", (code, signal) => resolve({ code, signal }));
        }
      );
      expect(cancelled).toBe(true);
      expect(exit.signal).toBeNull(); // The worker handled SIGTERM and unwound normally.
      expect(exit.code).not.toBe(0);
      expect(
        messages(stdout).some((event) => event.method === "report_asset_materialization")
      ).toBe(false);
      expect(messages(stdout).at(-1)?.method).toBe("closed");
      expect(existsSync(job.outputPath)).toBe(false);
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  }, 10_000);
});
