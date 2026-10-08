import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCloud } from "./workbench-cloud.js";
import { captureIo } from "./workbench.test-support.js";
import type { CliRun, CliPipeline } from "./cloud-protocol.js";

const host = "http://localhost:8787";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const pipeline: CliPipeline = {
  id: "cloud-orders",
  name: "Orders",
  repositoryId: "repo",
  path: "pipelines/orders.ts",
  branch: "main",
  commit: "stored-sha",
  enabled: true,
  available: true,
};
const baseRun: CliRun = {
  id: "run-1",
  pipelineId: pipeline.id,
  pipelineName: pipeline.name,
  status: "queued",
  createdAt: 1000,
  durationMs: 0,
  commit: "accepted-sha",
  branch: "main",
  trigger: "manual",
  actor: "user",
  steps: [],
  logs: [],
  artifacts: [],
  input: {},
};
async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "tubeless-cloud-command-"));
  roots.push(root);
  await promisify(execFile)("git", ["init", "--quiet"], { cwd: root });
  await mkdir(path.join(root, ".tubeless"));
  await writeFile(
    path.join(root, ".tubeless/cloud.json"),
    JSON.stringify({
      version: 1,
      host,
      workspaceId: "workspace",
      repositoryId: "repo",
      repository: "owner/repo",
      branch: "main",
    })
  );
  return root;
}
function service(
  options: {
    pipelines?: CliPipeline[];
    runs?: CliRun[];
    admissionStatus?: number;
    admissionError?: string;
    lostAcknowledgement?: boolean;
  } = {}
) {
  const calls: { method: string; url: string; body?: unknown; key?: string }[] = [];
  let admitted = false;
  const runs = [...(options.runs ?? [{ ...baseRun, status: "completed", result: { ok: true } }])];
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    calls.push({
      method,
      url: url.pathname,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      key: headers.get("Idempotency-Key") ?? undefined,
    });
    if (url.pathname.endsWith("/pipelines")) {
      if (method === "POST") return Response.json(pipeline, { status: 201 });
      return Response.json(options.pipelines ?? [pipeline]);
    }
    if (url.pathname.endsWith("/runs")) {
      if (options.admissionError)
        return Response.json(
          { error: { code: options.admissionError, message: "Rejected" } },
          { status: options.admissionStatus ?? 429 }
        );
      if (options.lostAcknowledgement && !admitted) {
        admitted = true;
        throw new Error("lost response");
      }
      return Response.json(baseRun, { status: 202 });
    }
    if (url.pathname.endsWith("/runs/run-1"))
      return Response.json(runs.length > 1 ? runs.shift() : runs[0]);
    throw new Error("Unexpected route");
  }) as typeof fetch;
  return {
    calls,
    fetch: fetcher,
    env: { TUBELESS_TOKEN: "fixture-secret" },
    sleep: async () => {},
  };
}

describe("Cloud remote commands", () => {
  it("help makes no HTTP requests", async () => {
    const dependencies = service();
    expect(await runCloud(["run", "--help"], captureIo("/detached"), dependencies)).toBe(0);
    expect(dependencies.calls).toEqual([]);
  });
  it("runs deployed code without executing a side-effecting local module", async () => {
    const root = await fixture();
    await mkdir(path.join(root, "pipelines"));
    const marker = path.join(root, "unexpected.txt");
    await writeFile(
      path.join(root, pipeline.path),
      `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'bad'); throw new Error('local source must not load');`
    );
    const io = captureIo(root);
    const dependencies = service();
    expect(await runCloud(["run", pipeline.path, "--json"], io, dependencies)).toBe(0);
    await expect(access(marker)).rejects.toThrow();
    expect(dependencies.calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      "GET /api/v1/workspaces/workspace/pipelines",
      "POST /api/v1/workspaces/workspace/runs",
      "GET /api/v1/workspaces/workspace/runs/run-1",
    ]);
    expect(JSON.parse(io.output.join(""))).toMatchObject({
      status: "completed",
      commit: "accepted-sha",
    });
    expect(io.errors.join("")).toContain("Local changes are not used");
    expect(io.errors.join("")).toContain("workspace=workspace");
    expect(io.output.join("")).not.toContain("fixture-secret");
  });
  it("resolves a missing local source path from a nested invocation", async () => {
    const root = await fixture();
    await mkdir(path.join(root, "nested"));
    const dependencies = service();
    expect(
      await runCloud(
        ["run", "../pipelines/orders.ts", "--detach", "--json"],
        captureIo(path.join(root, "nested")),
        dependencies
      )
    ).toBe(0);
    expect(dependencies.calls).toHaveLength(2);
  });
  it("explicit IDs work outside a Git repository", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "tubeless-detached-"));
    roots.push(root);
    const dependencies = service();
    expect(
      await runCloud(
        ["run", "--id", pipeline.id, "--host", host, "--workspace", "workspace", "--detach"],
        captureIo(root),
        dependencies
      )
    ).toBe(0);
  });
  it("missing or ambiguous selections never admit or automatically add", async () => {
    const root = await fixture();
    for (const pipelines of [[], [pipeline, { ...pipeline, id: "other", exportName: "Other" }]]) {
      const io = captureIo(root);
      const dependencies = service({ pipelines });
      expect(await runCloud(["run", pipeline.path], io, dependencies)).toBe(2);
      expect(dependencies.calls.every((call) => call.method === "GET")).toBe(true);
      expect(io.errors.join("")).toMatch(/cloud add|Ambiguous/);
    }
  });
  it("add registers only and reports the stored revision", async () => {
    const root = await fixture();
    const dependencies = service();
    const io = captureIo(root);
    expect(
      await runCloud(
        ["add", pipeline.path, "--export", "Orders", "--pipeline-id", "orders"],
        io,
        dependencies
      )
    ).toBe(0);
    expect(dependencies.calls).toHaveLength(1);
    expect(dependencies.calls[0]).toMatchObject({
      method: "POST",
      body: {
        path: pipeline.path,
        repositoryId: "repo",
        branch: "main",
        name: "orders",
        exportName: "Orders",
        pipelineId: "orders",
      },
    });
    expect(io.output.join("")).toContain("stored-sha");
  });
  it("invalid/oversized JSON input fails before admission", async () => {
    const root = await fixture();
    for (const input of [
      "null",
      "[]",
      "{",
      '"scalar"',
      JSON.stringify({ long: "x".repeat(65536) }),
    ]) {
      const dependencies = { ...service(), readStdin: async () => input };
      expect(
        await runCloud(["run", pipeline.path, "--input-file", "-"], captureIo(root), dependencies)
      ).toBe(4);
      expect(dependencies.calls.every((call) => call.method === "GET")).toBe(true);
    }
  });
  it("passes stdin JSON objects and reuses the key after a lost acknowledgement", async () => {
    const root = await fixture();
    const dependencies = {
      ...service({ lostAcknowledgement: true }),
      readStdin: async () => '{"hello":"world"}',
    };
    expect(
      await runCloud(
        ["run", pipeline.path, "--input-file", "-", "--detach"],
        captureIo(root),
        dependencies
      )
    ).toBe(0);
    const admissions = dependencies.calls.filter((call) => call.method === "POST");
    expect(admissions).toHaveLength(2);
    expect(admissions[0]!.key).toBe(admissions[1]!.key);
    expect(admissions[0]!.body).toEqual({ pipelineId: pipeline.id, input: { hello: "world" } });
  });
  it("reports a recoverable key after a server error following the POST", async () => {
    const root = await fixture();
    const dependencies = service({ admissionError: "internal_error", admissionStatus: 500 });
    const io = captureIo(root);
    expect(await runCloud(["run", pipeline.path, "--json"], io, dependencies)).toBe(2);
    const admissions = dependencies.calls.filter((call) => call.method === "POST");
    expect(admissions).toHaveLength(1);
    expect(io.errors.join("")).toContain(
      `Workspace: workspace; idempotency key: ${admissions[0]!.key}`
    );
    expect(io.output.join("")).toBe("");
  });
  it("reports a recoverable key for an unusable successful admission response", async () => {
    const root = await fixture();
    const dependencies = service();
    const original = dependencies.fetch;
    dependencies.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const response = await original(url, init);
      return init?.method === "POST"
        ? Response.json({ admitted: true }, { status: 202 })
        : response;
    }) as typeof fetch;
    const io = captureIo(root);
    expect(await runCloud(["run", pipeline.path], io, dependencies)).toBe(2);
    const admissions = dependencies.calls.filter((call) => call.method === "POST");
    expect(admissions).toHaveLength(1);
    expect(io.errors.join("")).toContain(`idempotency key: ${admissions[0]!.key}`);
  });
  it("reports the same key when interruption loses a pending POST acknowledgement", async () => {
    const root = await fixture();
    const controller = new AbortController();
    const dependencies = service();
    const original = dependencies.fetch;
    let markPosted: () => void = () => {};
    const posted = new Promise<void>((resolve) => {
      markPosted = resolve;
    });
    dependencies.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const response = await original(url, init);
      if (init?.method !== "POST") return response;
      markPosted();
      return new Promise<Response>(() => {});
    }) as typeof fetch;
    const io = { ...captureIo(root), signal: controller.signal };
    const result = runCloud(["run", pipeline.path, "--json"], io, dependencies);
    await posted;
    controller.abort();
    expect(await result).toBe(7);
    const admissions = dependencies.calls.filter((call) => call.method === "POST");
    expect(admissions).toHaveLength(1);
    expect(io.errors.join("")).toContain(
      `Workspace: workspace; idempotency key: ${admissions[0]!.key}`
    );
    expect(io.output.join("")).toBe("");
  });
  it("keeps one recoverable key through the bounded failed transport retry", async () => {
    const root = await fixture();
    const dependencies = service();
    const original = dependencies.fetch;
    dependencies.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const response = await original(url, init);
      if (init?.method === "POST") throw new Error("lost response");
      return response;
    }) as typeof fetch;
    const io = captureIo(root);
    expect(await runCloud(["run", pipeline.path], io, dependencies)).toBe(2);
    const admissions = dependencies.calls.filter((call) => call.method === "POST");
    expect(admissions).toHaveLength(2);
    expect(admissions[0]!.key).toBe(admissions[1]!.key);
    expect(io.errors.join("").match(/Admission could not be confirmed/g)).toHaveLength(1);
    expect(io.errors.join("")).toContain(`idempotency key: ${admissions[0]!.key}`);
  });
  it("definite 4xx rejection does not suggest an uncertain admission", async () => {
    const root = await fixture();
    const dependencies = service({ admissionError: "invalid_request", admissionStatus: 400 });
    const io = captureIo(root);
    expect(await runCloud(["run", pipeline.path], io, dependencies)).toBe(4);
    expect(dependencies.calls.filter((call) => call.method === "POST")).toHaveLength(1);
    expect(io.errors.join("")).not.toContain("idempotency key");
  });
  it("retains duplicate logs and deduplicates by snapshot array index", async () => {
    const root = await fixture();
    const log = { time: 1000, level: "info" as const, message: "repeated" };
    const dependencies = service({
      runs: [
        { ...baseRun, status: "running", logs: [log, log] },
        { ...baseRun, status: "completed", logs: [log, log] },
      ],
    });
    const io = captureIo(root);
    expect(await runCloud(["logs", "run-1", "--follow"], io, dependencies)).toBe(0);
    expect(io.output.join("").match(/repeated/g)).toHaveLength(2);
  });
  it.each([
    ["completed", 0],
    ["failed", 6],
    ["cancelled", 7],
  ] as const)("maps remote %s to %i", async (status, exit) => {
    const root = await fixture();
    const dependencies = service({ runs: [{ ...baseRun, status }] });
    expect(await runCloud(["run", pipeline.path, "--json"], captureIo(root), dependencies)).toBe(
      exit
    );
  });
  it("rate-limited admission exits execution failure without retry", async () => {
    const root = await fixture();
    const dependencies = service({ admissionError: "rate_limited" });
    expect(await runCloud(["run", pipeline.path], captureIo(root), dependencies)).toBe(6);
    expect(dependencies.calls.filter((call) => call.method === "POST")).toHaveLength(1);
  });
  it("interrupting foreground follow prints the run ID without cancellation", async () => {
    const root = await fixture();
    const controller = new AbortController();
    const dependencies = {
      ...service(),
      sleep: async () => {
        controller.abort();
        throw new Error("Aborted");
      },
    };
    const io = { ...captureIo(root), signal: controller.signal };
    expect(await runCloud(["run", pipeline.path], io, dependencies)).toBe(7);
    expect(io.errors.join("")).toContain("Run run-1");
    expect(dependencies.calls.filter((call) => call.method === "POST")).toHaveLength(1);
  });
  it("interrupting a pending stdin read admits no run", async () => {
    const root = await fixture();
    const controller = new AbortController();
    let inputStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      inputStarted = resolve;
    });
    const dependencies = {
      ...service(),
      readStdin: () => {
        inputStarted();
        return new Promise<string>(() => {});
      },
    };
    const io = { ...captureIo(root), signal: controller.signal };
    const result = runCloud(["run", pipeline.path, "--input-file", "-"], io, dependencies);
    await started;
    controller.abort();
    expect(await result).toBe(7);
    expect(dependencies.calls.every((call) => call.method === "GET")).toBe(true);
    expect(io.errors.join("")).not.toContain("idempotency key");
  });
  it("keeps automatic source selection distinct from an explicit default export", async () => {
    const root = await fixture();
    const dependencies = service();
    const io = captureIo(root);
    expect(await runCloud(["list"], io, dependencies)).toBe(0);
    expect(io.output.join("")).toContain("export=auto");
    const explicit = service();
    expect(
      await runCloud(["run", pipeline.path, "--export", "default"], captureIo(root), explicit)
    ).toBe(2);
    expect(explicit.calls.every((call) => call.method === "GET")).toBe(true);
  });
  it("stops foreground following after bounded transport failures and keeps the run URL", async () => {
    const root = await fixture();
    const dependencies = service();
    const original = dependencies.fetch;
    dependencies.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/runs/run-1")) throw new Error("network unavailable");
      return original(url, init);
    }) as typeof fetch;
    const io = captureIo(root);
    expect(await runCloud(["run", pipeline.path], io, dependencies)).toBe(2);
    expect(io.errors.join("")).toContain("Run run-1");
    expect(io.errors.join("")).toContain("/app/runs/run-1?workspace=workspace");
  });
  it.each([
    [403, "forbidden"],
    [404, "not_found"],
  ])("stops logs following on HTTP %i without hiding the run ID", async (status, code) => {
    const root = await fixture();
    const dependencies = service({ runs: [{ ...baseRun, status: "running" }] });
    const original = dependencies.fetch;
    let reads = 0;
    dependencies.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/runs/run-1") && ++reads > 1)
        return Response.json(
          { error: { code, message: "Run is no longer accessible" } },
          { status: Number(status) }
        );
      return original(url, init);
    }) as typeof fetch;
    const io = captureIo(root);
    expect(await runCloud(["logs", "run-1", "--follow", "--json"], io, dependencies)).toBe(2);
    expect(reads).toBe(2);
    expect(io.output.join("")).toBe("");
    expect(io.errors.join("")).toContain("Run run-1");
  });
  it.runIf(process.platform !== "win32")(
    "rejects FIFO input without waiting for a writer or admitting a run",
    async () => {
      const root = await fixture();
      await promisify(execFile)("mkfifo", [path.join(root, "input.json")]);
      const dependencies = service();
      expect(
        await runCloud(
          ["run", pipeline.path, "--input-file", "input.json"],
          captureIo(root),
          dependencies
        )
      ).toBe(4);
      expect(dependencies.calls.every((call) => call.method === "GET")).toBe(true);
    }
  );
  it("rejects illegal ID/selector and unrelated flag combinations before HTTP", async () => {
    const dependencies = service();
    const io = captureIo("/detached");
    expect(await runCloud(["run", "pipeline.ts", "--id", "cloud"], io, dependencies)).toBe(1);
    expect(await runCloud(["list", "--input-file", "input.json"], io, dependencies)).toBe(1);
    expect(dependencies.calls).toHaveLength(0);
  });
});
