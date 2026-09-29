import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

// Exercise the actual CLI, tools, checks and report writer without a live provider.
const preload = String.raw`
const turns = new Map();
const sequences = {
  "investigate-edit-verify": [
    ["read", {path: "price.mjs"}],
    ["edit", {path: "price.mjs", oldText: "Math.floor(value * 100)", newText: "Math.round((value + Number.EPSILON) * 100)"}],
    ["bash", {command: "node check.mjs"}],
  ],
  "project-context": [
    ["read", {path: "greet.mjs"}],
    ["edit", {path: "greet.mjs", oldText: 'return "hello"', newText: 'return "Ahoy, " + (name.trim() || "friend") + "!"'}],
    ["bash", {command: "node ../check.mjs"}],
  ],
  "recover-and-compact": [
    ["read", {path: "legacy-config.json"}],
    ["read", {path: "config/current.json"}],
    ["edit", {path: "config/current.json", oldText: '"retries":0', newText: '"retries":3'}],
    ["bash", {command: "node check.mjs"}],
  ],
};
if (process.env.EVAL_SKIP_RECOVERY === "true") sequences["recover-and-compact"].shift();
globalThis.fetch = async (url, options) => {
  if (url === "https://api.openai.com/v1/responses/compact") {
    return Response.json({object: "response.compaction", output: [{type: "compaction", encrypted_content: "fixture"}]});
  }
  if (url !== "https://api.openai.com/v1/responses") throw new Error("Unexpected fixture request");
  const body = JSON.parse(options.body);
  const kind = Object.keys(sequences).find(name => body.instructions.includes("tubeless-eval-" + name + "-"));
  if (!kind) throw new Error("Unrecognized fixture");
  const turn = turns.get(kind) ?? 0;
  turns.set(kind, turn + 1);
  const [name, input] = sequences[kind][turn] ?? ["_finish", {answer: "Fixture completed."}];
  return Response.json({status: "completed", output: [{
    type: "function_call", name, call_id: kind + "-" + turn,
    arguments: JSON.stringify({[name === "_finish" ? "result" : "input"]: input}),
  }]});
};
`;

it.each([false, true])(
  "retains evaluation evidence when the recovery assertion fails: %s",
  async (skipRecovery) => {
    const directory = await mkdtemp(join(tmpdir(), "tubeless-eval-report-"));
    try {
      const mockPath = join(directory, "provider.mjs");
      const reportPath = join(directory, "report.json");
      await writeFile(mockPath, preload);
      const run = () =>
        execFileSync(
          process.execPath,
          ["--import", mockPath, "scripts/eval-agent.mjs", reportPath],
          {
            encoding: "utf8",
            timeout: 20_000,
            env: {
              ...process.env,
              OPENAI_API_KEY: "offline-fixture",
              OPENAI_MODEL: "offline-fixture",
              EVAL_SKIP_RECOVERY: String(skipRecovery),
            },
          }
        );
      if (skipRecovery) expect(run).toThrow();
      else run();
      const report = JSON.parse(await readFile(reportPath, "utf8"));
      const [price, project, recovery] = report.results;
      expect(price.passed).toBe(true);
      expect(project.passed).toBe(true);
      expect(price.calls[0]).toMatchObject({
        id: "investigate-edit-verify-0",
        tool: "read",
        input: { path: "price.mjs" },
      });
      expect(price.outcomes[0]).toMatchObject({
        id: price.calls[0].id,
        ok: true,
        value: { content: expect.stringContaining("Math.floor") },
      });
      expect(recovery).toMatchObject({
        passed: !skipRecovery,
        answer: "Fixture completed.",
        verification: "config checks passed",
      });
      expect(recovery.compactions).toBeGreaterThan(0);
      expect(recovery.outcomes.at(-1)).toMatchObject({
        tool: "bash",
        ok: true,
        value: { exitCode: 0, stdout: "config checks passed\n" },
      });
      if (skipRecovery) {
        expect(recovery.error).toBe("Agent must observe and recover from the missing file");
        expect(recovery.calls[0].input).toEqual({ path: "config/current.json" });
      } else {
        expect(recovery.calls[0].input).toEqual({ path: "legacy-config.json" });
        expect(recovery.outcomes[0]).toMatchObject({ ok: false, error: { code: "ENOENT" } });
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
);
