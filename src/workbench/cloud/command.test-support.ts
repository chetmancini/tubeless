import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, vi } from "vitest";
import type { CliRun, CliPipeline, CliWorkspace } from "./protocol.js";

export const host = "http://localhost:8787";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
export const pipeline: CliPipeline = {
  id: "cloud-orders",
  name: "Orders",
  slug: "orders",
  branch: "main",
  commit: "stored-sha",
  enabled: true,
  available: true,
};
export const baseRun: CliRun = {
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
export async function fixture(): Promise<string> {
  const root = await testDirectory();
  await mkdir(path.join(root, ".tubeless"));
  await writeFile(path.join(root, ".tubeless/cloud.json"), "stale malformed project configuration");
  return root;
}
export function service(
  options: {
    pipelines?: CliPipeline[];
    workspaces?: CliWorkspace[];
    runs?: CliRun[];
    admission?: CliRun;
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
    if (url.pathname === "/api/v1/session")
      return Response.json({
        user: { id: "user", login: "user", name: "User", email: "user@example.com", avatar: "" },
        expiresAt: Date.now() + 60000,
        workspaces: options.workspaces ?? [
          {
            id: "workspace",
            name: "Workspace",
            slug: "workspace",
            role: "owner",
          },
        ],
      });
    if (url.pathname.endsWith("/pipelines")) return Response.json(options.pipelines ?? [pipeline]);
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
      return Response.json(options.admission ?? baseRun, { status: 202 });
    }
    if (url.pathname.endsWith(`/runs/${encodeURIComponent(options.admission?.id ?? baseRun.id)}`))
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

export async function testDirectory(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "tubeless-cloud-command-"));
  roots.push(root);
  return root;
}
