import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

// Exercise the evaluator, tools, checks and report writer without a live provider.
const preload = String.raw`
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";

const turns = new Map();
const sequences = {
  "investigate-edit-verify": [
    [["read", {path: "price.mjs"}]],
    [["edit", {path: "price.mjs", oldText: "Math.floor(value * 100)", newText: "Math.round((value + Number.EPSILON) * 100)"}]],
    [["bash", {command: "node check.mjs"}]],
  ],
  "project-context": [
    [["read", {path: "greet.mjs"}]],
    [["edit", {path: "greet.mjs", oldText: 'return "hello"', newText: 'return "Ahoy, " + (name.trim() || "friend") + "!"'}]],
    [["bash", {command: "node ../check.mjs"}]],
  ],
  "recover-and-compact": [
    [["read", {path: "legacy-config.json"}]],
    [["read", {path: "config/current.json"}]],
    [["edit", {path: "config/current.json", oldText: '"retries":0', newText: '"retries":3'}]],
    [["bash", {command: "node check.mjs"}]],
  ],
  "nested-guidance": [
    [["read", {path: "src/AGENTS.md"}]],
    [["read", {path: "src/code.txt"}]],
    [["_finish", {answer: "Scoped code: cobalt"}]],
  ],
};
const guidance = sequences["nested-guidance"];
if (process.env.EVAL_RECOVERY === "guidance-skipped") guidance.shift();
if (process.env.EVAL_RECOVERY === "guidance-batched") guidance.splice(0, 2, [...guidance[0], ...guidance[1]]);
if (process.env.EVAL_RECOVERY === "guidance-empty") guidance[0][0][1].startLine = 999;
if (process.env.EVAL_RECOVERY === "code-empty") guidance[1][0][1].startLine = 999;
if (process.env.EVAL_RECOVERY === "guidance-bounded") {
  guidance[0][0][1].maxLines = 1;
  guidance[1][0][1].maxLines = 1;
}
const failedRead = {
  "guidance-failed": "/src/AGENTS.md",
  "code-failed": "/src/code.txt",
}[process.env.EVAL_RECOVERY];
if (failedRead) {
  // Fail only the tool's file open, leaving fixture setup and independent checks intact.
  const open = fs.open;
  fs.open = async (path, ...args) => {
    if (path.includes("tubeless-eval-nested-guidance-") && path.endsWith(failedRead)) {
      throw Object.assign(new Error("Fixture read denied"), {code: "EACCES"});
    }
    return open(path, ...args);
  };
  syncBuiltinESMExports();
}
const mutations = {
  "guidance-create": [[["write", {path: "extra.txt", content: "unexpected file"}]]],
  "guidance-restore": [
    [["edit", {path: "src/code.txt", oldText: "cobalt", newText: "changed"}]],
    [["edit", {path: "src/code.txt", oldText: "changed", newText: "cobalt"}]],
  ],
  "guidance-bash": [[["bash", {command: "touch extra.txt"}]]],
}[process.env.EVAL_RECOVERY];
if (mutations) guidance.splice(2, 0, ...mutations);
const recovery = sequences["recover-and-compact"];
if (process.env.EVAL_RECOVERY === "skipped") recovery.shift();
if (process.env.EVAL_RECOVERY === "batched") recovery.splice(0, 2, [...recovery[0], ...recovery[1]]);
const exploration = {
  "list-root": ["list", {}],
  "list-config": ["list", {path: "./config"}],
  "search": ["search", {query: "retries"}],
  "bash": ["bash", {command: "find . -name current.json"}],
  "delayed": ["read", {path: "unrelated.txt"}],
  "unrelated-list": ["list", {path: ".git"}],
  "unrelated-search": ["search", {query: "no-matching-configuration"}],
}[process.env.EVAL_RECOVERY];
if (exploration) recovery.splice(1, 0, [exploration]);
globalThis.fetch = async (url, options) => {
  if (url === "https://api.openai.com/v1/responses/compact") {
    return Response.json({object: "response.compaction", output: [{type: "compaction", encrypted_content: "fixture"}]});
  }
  if (url !== "https://api.openai.com/v1/responses") throw new Error("Unexpected fixture request");
  const body = JSON.parse(options.body);
  if (body.reasoning?.effort !== "high") throw new Error("Evaluation must explicitly request high reasoning");
  const kind = Object.keys(sequences).find(name => body.instructions.includes("tubeless-eval-" + name + "-"));
  if (!kind) throw new Error("Unrecognized fixture");
  const turn = turns.get(kind) ?? 0;
  turns.set(kind, turn + 1);
  const batch = sequences[kind][turn] ?? [["_finish", {answer: "Fixture completed."}]];
  return Response.json({status: "completed", output: batch.map(([name, input], index) => ({
    type: "function_call", name, call_id: kind + "-" + turn + "-" + index,
    arguments: JSON.stringify({[name === "_finish" ? "result" : "input"]: input}),
  }))});
};
`;

const recoveryError = "The error-observing decision must read or locate the current configuration";
const guidanceError = "Nested guidance must be read before the requested first task read";
const readOnlyError = "Read-only task must use only read, list, and search tools";
it.each([
  ["ordered", undefined, undefined],
  ["list-root", recoveryError, undefined],
  ["list-config", undefined, undefined],
  ["search", undefined, undefined],
  ["bash", undefined, undefined],
  ["skipped", "Agent must perform the requested missing-file read first", undefined],
  [
    "batched",
    "Agent must wait for the missing-file result before choosing recovery calls",
    undefined,
  ],
  ["delayed", recoveryError, undefined],
  ["unrelated-list", recoveryError, undefined],
  ["unrelated-search", recoveryError, undefined],
  ["guidance-skipped", undefined, guidanceError],
  ["guidance-batched", undefined, guidanceError],
  ["guidance-bounded", undefined, undefined],
  [
    "guidance-empty",
    undefined,
    "Read of src/AGENTS.md must successfully return the expected contents",
  ],
  [
    "guidance-failed",
    undefined,
    "Read of src/AGENTS.md must successfully return the expected contents",
  ],
  ["code-empty", undefined, "Read of src/code.txt must successfully return the expected contents"],
  ["code-failed", undefined, "Read of src/code.txt must successfully return the expected contents"],
  ["guidance-create", undefined, readOnlyError],
  ["guidance-restore", undefined, readOnlyError],
  ["guidance-bash", undefined, readOnlyError],
] as const)(
  "retains decision batches and acceptance verdicts for %s",
  async (mode, expectedError, expectedGuidanceError) => {
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
              EVAL_RECOVERY: mode,
            },
          }
        );
      const guidanceFailure = expectedGuidanceError !== undefined;
      if (expectedError || guidanceFailure) expect(run).toThrow();
      else run();
      const report = JSON.parse(await readFile(reportPath, "utf8"));
      const [price, project, guidance, recovery] = report.results;
      expect(price.passed).toBe(true);
      expect(project.passed).toBe(true);
      expect(guidance).toMatchObject({
        passed: !guidanceFailure,
        answer: "Scoped code: cobalt",
        verification: "guidance checks passed",
      });
      expect(guidance.error).toBe(expectedGuidanceError);
      if (["guidance-empty", "code-empty", "guidance-failed", "code-failed"].includes(mode)) {
        const index = mode.startsWith("guidance-") ? 0 : 1;
        expect(guidance.turns[index + 1].outcomes[0]).toMatchObject({
          id: guidance.turns[index].decision.calls[0].id,
          tool: "read",
          ...(mode.endsWith("empty")
            ? { ok: true, value: { content: "" } }
            : { ok: false, error: { code: "EACCES" } }),
        });
      }
      if (expectedGuidanceError === readOnlyError) {
        const mutations = guidance.outcomes.filter((outcome: { tool: string }) =>
          ["write", "edit", "bash"].includes(outcome.tool)
        );
        expect(mutations.length).toBeGreaterThan(0);
        expect(mutations.every((outcome: { ok: boolean }) => outcome.ok)).toBe(true);
      }
      expect(price.calls[0]).toMatchObject({
        id: "investigate-edit-verify-0-0",
        tool: "read",
        input: { path: "price.mjs" },
      });
      expect(price.outcomes[0]).toMatchObject({
        id: price.calls[0].id,
        ok: true,
        value: { content: expect.stringContaining("Math.floor") },
      });
      expect(recovery).toMatchObject({
        passed: expectedError === undefined,
        answer: "Fixture completed.",
        verification: "config checks passed",
      });
      expect(recovery.error).toBe(expectedError);
      expect(recovery.compactions).toBeGreaterThan(0);
      expect(recovery.outcomes.at(-1)).toMatchObject({
        tool: "bash",
        ok: true,
        value: { exitCode: 0, stdout: "config checks passed\n" },
      });
      expect(recovery.turns[0].outcomes).toEqual([]);
      expect(recovery.turns[0].decision.calls).toEqual(
        recovery.calls.slice(0, mode === "batched" ? 2 : 1)
      );
      if (mode === "skipped") {
        expect(recovery.calls[0].input).toEqual({ path: "config/current.json" });
      } else {
        expect(recovery.calls[0].input).toEqual({ path: "legacy-config.json" });
        expect(recovery.turns[1].outcomes[0]).toMatchObject({
          id: recovery.calls[0].id,
          tool: "read",
          ok: false,
          error: { code: "ENOENT" },
        });
        if (mode === "ordered") {
          expect(recovery.turns[1].decision.calls[0].input).toEqual({
            path: "config/current.json",
          });
        } else if (expectedError === recoveryError) {
          // The third decision recovers successfully, but must not rescue the second one's verdict.
          expect(recovery.turns[2].decision.calls[0].input).toEqual({
            path: "config/current.json",
          });
        }
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
);
