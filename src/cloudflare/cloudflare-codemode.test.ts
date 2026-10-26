import { Miniflare, NoOpLog } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { manifestModules } from "./cloudflare-workerd.test-support.js";

// A Worker that runs a code-mode agent: the request body is the script, and the response is
// the codemode outcome. `?executor=none` omits the executor; `?cpu=` sets the CPU budget.
const WORKER = String.raw`
import { env } from "cloudflare:workers";
import { defineAgentLoop, defineTool } from "./agent/agent.js";
import { createWorkerLoaderCodemodeExecutor } from "./cloudflare/cloudflare.js";
const schema = (descriptor) => ({
  "~standard": { version: 1, vendor: "test", validate: (value) => ({ value }), jsonSchema: { input: () => descriptor, output: () => descriptor } },
});
const double = defineTool({
  description: "Double a number",
  inputSchema: schema({ type: "object", properties: { n: { type: "number" } }, required: ["n"] }),
  outputSchema: schema({ type: "number" }),
  run: ({ n }) => n * 2,
});
const unavailable = () => { throw new Error("no workspace in this test"); };
const environment = {
  id: "test:none", resolveCwd: () => "/", projectInstructions: () => [],
  read: unavailable, write: unavailable, edit: unavailable, bash: unavailable, list: unavailable, search: unavailable,
};
export default {
  async fetch(request) {
    const url = new URL(request.url);
    const code = await request.text();
    const codemode = url.searchParams.get("executor") === "none"
      ? true
      : { executor: createWorkerLoaderCodemodeExecutor(env.LOADER, { cpuMs: Number(url.searchParams.get("cpu") ?? 30000) }) };
    const agent = defineAgentLoop({
      id: "workerd-codemode",
      environment,
      defaultTools: [],
      tools: { double },
      codemode,
      inputSchema: schema({ type: "object", properties: {} }),
      resultSchema: schema({}),
      resultJsonSchema: {},
      initialState: () => null,
      decide: (state) => state === null
        ? { kind: "continue", calls: [{ id: "script", tool: "codemode", input: { code } }] }
        : { kind: "finish", result: state },
      reduce: (_state, [outcome]) => outcome,
    });
    const run = await agent.run({});
    return Response.json(run.status === "completed" ? run.value : { failed: run.errors.map((error) => error.message) });
  },
};
`;

let mf: Miniflare;
beforeAll(async () => {
  mf = new Miniflare({
    log: new NoOpLog(),
    telemetry: { enabled: false },
    workers: [
      {
        config: {
          name: "codemode-test",
          compatibilityDate: "2026-10-01",
          compatibilityFlags: ["nodejs_compat"],
          manifest: { mainModule: "worker.js", modules: manifestModules(WORKER) },
          env: { LOADER: { type: "worker-loader" } },
        },
      },
    ],
  });
  await mf.ready;
}, 60_000);
afterAll(() => mf?.dispose());

async function script(code: string, query = ""): Promise<Record<string, unknown>> {
  const response = await mf.dispatchFetch(`http://codemode.test/${query}`, {
    method: "POST",
    body: code,
  });
  return (await response.json()) as Record<string, unknown>;
}

describe("Worker Loader code-mode executor", () => {
  it("runs an agent's script in a Dynamic Worker that calls host tools", async () => {
    expect(
      await script(`
        let total = 0;
        for (const n of [1, 2, 3]) total += await tools.double({ n });
        console.log("total", total);
        return { total };
      `)
    ).toMatchObject({
      tool: "codemode",
      ok: true,
      value: { result: { total: 12 }, logs: ["total 12"], logsTruncated: false },
    });
  });

  it("gives scripts no network, code generation or host bindings", async () => {
    const probes = await script(`
      const blocked = {};
      for (const [name, probe] of Object.entries({
        fetch: () => fetch("https://example.com"),
        eval: () => eval("1"),
        function: () => tools.double.constructor("return 1")(),
        env: () => { if (typeof env === "undefined") throw new ReferenceError("env is not defined"); },
      })) {
        try { await probe(); blocked[name] = false; } catch (error) { blocked[name] = error.name; }
      }
      return blocked;
    `);
    const result = (probes.value as { result: Record<string, unknown> }).result;
    for (const name of ["fetch", "eval", "function", "env"]) expect(result[name]).not.toBe(false);
  });

  it("reports syntax and runtime errors with script line numbers", async () => {
    expect(await script("return 1;\nconst = 1;")).toMatchObject({
      ok: false,
      error: {
        code: "CODEMODE_SCRIPT_ERROR",
        message: "SyntaxError: Unexpected token '=' (line 2)",
      },
    });
    const thrown = await script('await tools.double({ n: 1 });\nthrow new Error("boom");');
    expect(thrown).toMatchObject({ ok: false, error: { code: "CODEMODE_SCRIPT_ERROR" } });
    expect((thrown.error as { message: string }).message).toBe("boom (line 2, column 7)");
  });

  it("fails the run, rather than each script, when code mode has no executor on Workers", async () => {
    const result = await script("return 1;", "?executor=none");
    expect(result.failed).toEqual([
      expect.stringContaining(
        "Code mode's default executor needs node:worker_threads; pass codemode: { executor } on this platform"
      ),
    ]);
  });
});
