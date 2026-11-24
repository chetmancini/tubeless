import { describe, expect, it, vi } from "vitest";
import { runCloud } from "./index.js";
import { captureIo } from "../../workbench.test-support.js";
import { pipeline, fixture, service } from "./index.test-support.js";

describe("Cloud automation commands", () => {
  it.each([
    {
      args: ["list", "--json"],
      request: "GET /api/v1/workspaces/workspace/pipelines",
      expected: [{ id: pipeline.id, slug: "orders" }],
    },
    {
      args: ["logs", "run-1", "--json"],
      request: "GET /api/v1/workspaces/workspace/runs/run-1",
      expected: { id: "run-1", status: "completed", logs: [] },
    },
    {
      args: ["inspect", "run-1", "--json"],
      request: "GET /api/v1/workspaces/workspace/runs/run-1",
      expected: { id: "run-1", status: "completed", result: { ok: true } },
    },
    {
      args: ["cancel", "run-1", "--json"],
      request: "POST /api/v1/workspaces/workspace/runs/run-1/cancel",
      expected: { runId: "run-1", status: "cancelled", alreadyFinished: false },
    },
    {
      args: ["run", "--id", pipeline.id, "--detach", "--json"],
      request: "POST /api/v1/workspaces/workspace/runs",
      expected: { id: "run-1", pipelineId: pipeline.id, status: "queued" },
    },
  ])(
    "uses an injected automation bearer for $request without session or keychain access",
    async ({ args, expected, request }) => {
      const dependencies = service({
        cancellation: { runId: "run-1", status: "cancelled", alreadyFinished: false },
      });
      const fetcher = dependencies.fetch;
      const token = "tlc_ci_v1.test-only-automation-bearer";
      const store = { get: vi.fn(), set: vi.fn(), delete: vi.fn() };
      dependencies.env.TUBELESS_TOKEN = token;
      dependencies.fetch = async (url, init) => {
        expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${token}`);
        expect(init?.credentials).toBe("omit");
        expect(String(url)).not.toContain("/session");
        return fetcher(url, init);
      };
      const io = captureIo(await fixture());
      expect(
        await runCloud([...args, "--workspace", "workspace"], io, { ...dependencies, store })
      ).toBe(0);
      expect(store.get).not.toHaveBeenCalled();
      expect(store.set).not.toHaveBeenCalled();
      expect(store.delete).not.toHaveBeenCalled();
      expect(dependencies.calls.map(({ method, url }) => `${method} ${url}`)).toEqual([request]);
      expect(io.output.join("") + io.errors.join("")).not.toContain(token);
      expect(JSON.parse(io.output.join(""))).toMatchObject(expected);
    }
  );

  it.each([{ args: ["list"] }, { args: ["inspect", "run-1"] }, { args: ["cancel", "run-1"] }])(
    "requires an explicit automation workspace for $args without requesting a session",
    async ({ args }) => {
      const dependencies = service();
      dependencies.env.TUBELESS_TOKEN = "tlc_ci_v1.test-only";
      const io = captureIo(await fixture());
      expect(await runCloud(args, io, dependencies)).toBe(2);
      expect(dependencies.calls).toEqual([]);
      expect(io.errors.join("")).toContain("--workspace");
    }
  );

  it.each([
    [401, "unauthenticated"],
    [403, "forbidden"],
    [404, "not_found"],
  ] as const)(
    "retains service credential/scope denials (%s) without fallback",
    async (status, code) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          Response.json({ error: { code, message: "Denied credential" } }, { status })
        );
      const io = captureIo(await fixture());
      expect(
        await runCloud(["run", "--id", pipeline.id, "--workspace", "workspace", "--detach"], io, {
          env: { TUBELESS_TOKEN: "tlc_ci_v1.test-only" },
          fetch: fetcher,
        })
      ).toBe(2);
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(fetcher.mock.calls[0][1]?.method).toBe("POST");
      expect(io.errors.join("")).not.toContain("Admission could not be confirmed");
      expect(io.output.join("")).toBe("");
    }
  );

  it("keeps the admitted run when a run-only credential cannot follow", async () => {
    const dependencies = service();
    const original = dependencies.fetch;
    dependencies.fetch = async (url, init) =>
      init?.method === "POST"
        ? original(url, init)
        : Response.json(
            { error: { code: "forbidden", message: "Read scope required" } },
            { status: 403 }
          );
    const io = captureIo(await fixture());
    expect(
      await runCloud(
        ["run", "--id", pipeline.id, "--workspace", "workspace", "--json"],
        io,
        dependencies
      )
    ).toBe(2);
    expect(dependencies.calls.filter((call) => call.method === "POST")).toHaveLength(1);
    expect(io.errors.join("")).toContain("Run run-1");
    expect(io.errors.join("")).toContain("--detach");
    expect(io.output.join("")).toBe("");
  });
});
