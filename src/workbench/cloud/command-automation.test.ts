import { describe, expect, it, vi } from "vitest";
import { runCloud } from "./command.js";
import { captureIo } from "../workbench.test-support.js";
import { pipeline, fixture, service } from "./command.test-support.js";

describe("Cloud automation commands", () => {
  it.each([
    ["list", "--json"],
    ["logs", "run-1", "--json"],
    ["run", "--id", pipeline.id, "--detach", "--json"],
  ])(
    "uses an injected automation bearer without session or keychain access: %j",
    async (...args) => {
      const dependencies = service();
      const fetcher = dependencies.fetch;
      const token = "tlc_ci_v1.test-only-automation-bearer";
      const store = { get: vi.fn(), set: vi.fn(), delete: vi.fn() };
      dependencies.env.TUBELESS_TOKEN = token;
      dependencies.fetch = (async (url, init) => {
        expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${token}`);
        expect(init?.credentials).toBe("omit");
        expect(String(url)).not.toContain("/session");
        if (args[0] === "run") expect(init?.method).toBe("POST");
        return fetcher(url, init);
      }) as typeof fetch;
      const io = captureIo(await fixture());
      expect(
        await runCloud([...args, "--workspace", "workspace"], io, { ...dependencies, store })
      ).toBe(0);
      expect(store.get).not.toHaveBeenCalled();
      expect(store.set).not.toHaveBeenCalled();
      expect(store.delete).not.toHaveBeenCalled();
      expect(io.output.join("") + io.errors.join("")).not.toContain(token);
      expect(JSON.parse(io.output.join(""))).toBeDefined();
    }
  );

  it("requires an explicit automation workspace without requesting a session", async () => {
    const dependencies = service();
    dependencies.env.TUBELESS_TOKEN = "tlc_ci_v1.test-only";
    const io = captureIo(await fixture());
    expect(await runCloud(["list"], io, dependencies)).toBe(2);
    expect(dependencies.calls).toEqual([]);
    expect(io.errors.join("")).toContain("--workspace");
  });

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
    dependencies.fetch = (async (url, init) =>
      init?.method === "POST"
        ? original(url, init)
        : Response.json(
            { error: { code: "forbidden", message: "Read scope required" } },
            { status: 403 }
          )) as typeof fetch;
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
