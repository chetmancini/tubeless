import { expect, it, vi } from "vitest";
import { captureIo } from "../../workbench.test-support.js";
import { runCloud } from "./index.js";
import { baseRun, fixture, host, service } from "./index.test-support.js";

it("inspects with a stored session on the selected host and redacts retained output", async () => {
  const token = "stored-bearer";
  const run = {
    ...baseRun,
    status: "completed" as const,
    pipelineName: `Orders\u001b[31m ${token}`,
    result: { [token]: token, nested: ["a", token] },
  };
  const dependencies = service({ runs: [run] });
  const store = {
    get: vi.fn(async () => ({ token, expiresAt: Date.now() + 60_000 })),
    set: vi.fn(),
    delete: vi.fn(),
  };
  const io = captureIo(await fixture());
  const args = ["inspect", run.id, "--host", host];
  for (const format of [[], ["--json"]]) {
    expect(
      await runCloud([...args, ...format], io, {
        env: {},
        store,
        fetch: async (url, init) => {
          expect(new URL(String(url)).origin).toBe(host);
          expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${token}`);
          return dependencies.fetch(url, init);
        },
      })
    ).toBe(0);
  }
  expect(store.get).toHaveBeenCalledWith(host);
  expect(store.set).not.toHaveBeenCalled();
  expect(store.delete).not.toHaveBeenCalled();
  expect(dependencies.calls.map((call) => call.url)).toEqual([
    "/api/v1/session",
    "/api/v1/workspaces/workspace/runs/run-1",
    "/api/v1/session",
    "/api/v1/workspaces/workspace/runs/run-1",
  ]);
  const [human, machine] = io.output;
  expect(human).toContain("Source: main @ accepted-sha");
  expect(human).toContain("Result:");
  expect(human).not.toContain("\u001b");
  expect(io.output.join("") + io.errors.join("")).not.toContain(token);
  const decoded = JSON.parse(machine);
  expect(decoded).not.toHaveProperty("diagnostics");
  expect(decoded.result.nested[0]).toBe("a");
  expect(Object.keys(decoded.result)).toHaveLength(2);
});
