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
  "typed-triage-text": [[["_finish", {urgent: ["T6", "T2", "T4"]}]]],
  "typed-triage-json": [[["_finish", {urgent: ["T2", "T4", "T6"]}]]],
  "large-inventory": [
    [["support__get_ticket", {id: "S-1042"}]],
    [["billing__get_balance", {customerId: "C-77"}]],
    [["_finish", {answer: "Balance: 1234.56 USD"}]],
  ],
  "aggregate-files": [
    Array.from({length: 12}, (_, index) => ["read", {path: "data/item-" + String(index + 1).padStart(2, "0") + ".json"}]),
    [["_finish", {answer: "Total: 1362"}]],
  ],
  "nested-guidance": [
    [["read", {path: "src/AGENTS.md"}]],
    [["read", {path: "src/code.txt"}]],
    [["_finish", {answer: "Scoped code: cobalt"}]],
  ],
};
if (process.env.EVAL_RECOVERY === "transcript-omission") sequences["typed-triage-json"][0][0][1].urgent = ["x".repeat(70000)];
if (process.env.EVAL_RECOVERY === "triage-wrong") sequences["typed-triage-json"][0][0][1].urgent = ["T2", "T4"];
// Offline code mode: one script chains both inventory tools through the Node executor.
if (process.env.EVAL_CODEMODE === "1")
  sequences["large-inventory"] = [
    [["codemode", {code: "const ticket = await tools.support__get_ticket({ id: 'S-1042' });\nreturn await tools.billing__get_balance({ customerId: ticket.customerId });"}]],
    [["_finish", {answer: "Balance: 1234.56 USD"}]],
  ];
if (process.env.EVAL_RECOVERY === "inventory-guess")
  sequences["large-inventory"] = [[["_finish", {answer: "Balance: 1234.56 USD"}]]];
const aggregate = sequences["aggregate-files"];
// Read-only answers may come from a command rather than read calls.
if (process.env.EVAL_RECOVERY === "aggregate-bash") aggregate[0] = [["bash", {command: "cat data/*.json"}]];
if (process.env.EVAL_RECOVERY === "aggregate-guess") aggregate.splice(0, 1);
if (process.env.EVAL_RECOVERY === "aggregate-wrong") aggregate[1][0][1].answer = "Total: 13620";
if (process.env.EVAL_RECOVERY === "aggregate-create")
  aggregate.splice(1, 0, [["bash", {command: "node -e \"require('fs').writeFileSync('data/extra.txt', 'scratch')\""}]]);
if (process.env.EVAL_RECOVERY === "aggregate-restore")
  aggregate.splice(1, 0,
    [["edit", {path: "data/README.txt", oldText: "Notes", newText: "Changed"}]],
    [["edit", {path: "data/README.txt", oldText: "Changed", newText: "Notes"}]]);
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
const missingStartup = process.env.EVAL_RECOVERY === "startup-missing";
if (failedRead || missingStartup) {
  // Fail only the tool's file open, leaving fixture setup and independent checks intact.
  const open = fs.open;
  fs.open = async (path, ...args) => {
    if (missingStartup && path.includes("tubeless-eval-project-context-") && path.endsWith("/AGENTS.md")) {
      throw Object.assign(new Error("Fixture startup guidance missing"), {code: "ENOENT"});
    }
    if (failedRead && path.includes("tubeless-eval-nested-guidance-") && path.endsWith(failedRead)) {
      throw Object.assign(new Error("Fixture read denied"), {code: "EACCES"});
    }
    return open(path, ...args);
  };
  syncBuiltinESMExports();
}
const startupRead = {
  "startup-reread": ["read", {path: "./AGENTS.md"}],
  "startup-root-reread": ["read", {path: "../AGENTS.md"}],
  "startup-test-read": ["read", {path: "../check.mjs"}],
  "startup-search": ["search", {query: "Greeting", path: "."}],
  "startup-bash": ["bash", {command: "cat AGENTS.md"}],
  "startup-check-cwd": ["bash", {command: "node ../check.mjs", cwd: "../.git"}],
  "startup-failed-check": ["bash", {command: "node ../check.mjs"}],
}[process.env.EVAL_RECOVERY];
if (startupRead) sequences["project-context"].unshift([startupRead]);
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
  const anthropic = url === "https://api.anthropic.com/v1/messages";
  if (!anthropic && url !== "https://api.openai.com/v1/responses") throw new Error("Unexpected fixture request");
  const body = JSON.parse(options.body);
  if (anthropic && body.compaction) return Response.json({type: "message", role: "assistant", stop_reason: "compaction", content: [{type: "compaction", content: "Fixture summary", signature: "fixture"}]});
  if ((anthropic ? body.output_config?.effort : body.reasoning?.effort) !== "high") throw new Error("Evaluation must explicitly request high reasoning");
  const instructions = anthropic ? (Array.isArray(body.system) ? body.system.map(block => block.text).join("\n") : body.system) : body.instructions;
  const kind = Object.keys(sequences).find(name => instructions.includes("tubeless-eval-" + name + "-"));
  if (!kind) throw new Error("Unrecognized fixture");
  const turn = turns.get(kind) ?? 0;
  turns.set(kind, turn + 1);
  const batch = sequences[kind][turn] ?? [["_finish", {answer: "Fixture completed."}]];
  if (anthropic) return Response.json({type: "message", role: "assistant", stop_reason: "tool_use", content: batch.map(([name, input], index) => ({
    type: "tool_use", name, id: kind + "-" + turn + "-" + index,
    input: {[name === "_finish" ? "result" : "input"]: input},
  }))});
  return Response.json({status: "completed", output: batch.map(([name, input], index) => ({
    type: "function_call", name, call_id: kind + "-" + turn + "-" + index,
    arguments: JSON.stringify({[name === "_finish" ? "result" : "input"]: input}),
  }))});
};
`;

const recoveryError = "The error-observing decision must read or locate the current configuration";
const guidanceError = "Nested guidance must be read before the requested first task read";
const readOnlyError = "Read-only task must use only read, list, and search tools";
const startupError = "Startup-guidance task must access only greet.mjs and run node ../check.mjs";
it.each([
  ["ordered", undefined, undefined],
  ["aggregate-wrong", undefined, undefined],
  ["aggregate-bash", undefined, undefined],
  ["aggregate-guess", undefined, undefined],
  ["triage-wrong", undefined, undefined],
  ["inventory-guess", undefined, undefined],
  ["aggregate-create", undefined, undefined],
  ["aggregate-restore", undefined, undefined],
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
  ["startup-reread", undefined, undefined, startupError],
  ["startup-root-reread", undefined, undefined, startupError],
  ["startup-test-read", undefined, undefined, startupError],
  ["startup-search", undefined, undefined, startupError],
  ["startup-bash", undefined, undefined, startupError],
  ["startup-check-cwd", undefined, undefined, startupError],
  [
    "startup-missing",
    undefined,
    undefined,
    "Startup guidance must be included in the first model request",
  ],
  [
    "startup-failed-check",
    undefined,
    undefined,
    "Startup-guidance task must pass verification without learning from failed checks",
  ],
] as const)(
  "retains decision batches and acceptance verdicts for %s",
  async (mode, expectedError, expectedGuidanceError, expectedStartupError?: string) => {
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
      const aggregateError = {
        "aggregate-wrong": "Answer must be exactly Total: 1362",
        "aggregate-create": "Read-only task must not change workspace files",
        "aggregate-restore": "Read-only task must not call write or edit",
        "aggregate-guess": "Agent must observe the data files it aggregates",
      }[mode as string];
      const aggregateFailure = aggregateError !== undefined;
      const triageFailure = mode === "triage-wrong";
      const inventoryFailure = mode === "inventory-guess";
      if (
        expectedError ||
        guidanceFailure ||
        expectedStartupError ||
        aggregateFailure ||
        triageFailure ||
        inventoryFailure
      )
        expect(run).toThrow();
      else run();
      const report = JSON.parse(await readFile(reportPath, "utf8"));
      const results = Object.fromEntries(
        report.results.map((result: { id: string }) => [result.id, result])
      );
      const price = results["investigate-edit-verify"];
      const project = results["project-context"];
      const guidance = results["nested-guidance"];
      const recovery = results["recover-and-compact"];
      expect(results["aggregate-files"]).toMatchObject({
        passed: !aggregateFailure,
        answer: mode === "aggregate-wrong" ? "Total: 13620" : "Total: 1362",
        verification: "aggregate checks passed",
      });
      expect(results["aggregate-files"].error).toBe(aggregateError);
      for (const result of report.results)
        expect(result).toEqual(
          expect.objectContaining({
            toolCount: expect.any(Number),
            toolDescriptorBytes: expect.any(Number),
          })
        );
      expect(results["typed-triage-text"]).toMatchObject({
        passed: true,
        output: { urgent: ["T6", "T2", "T4"] },
        toolCount: 0,
      });
      expect(results["typed-triage-json"]).toMatchObject({
        passed: !triageFailure,
        ...(triageFailure
          ? { error: "Urgent tickets must be exactly T2, T4 and T6; got T2, T4" }
          : {}),
      });
      expect(results["large-inventory"]).toMatchObject(
        inventoryFailure
          ? {
              passed: false,
              error: "Agent must look up ticket S-1042, then the balance of its customer",
            }
          : {
              passed: true,
              codemode: false,
              output: { answer: "Balance: 1234.56 USD" },
              toolCount: 49,
              turnCount: 3,
              toolLog: [
                { tool: "support__get_ticket", ok: true },
                { tool: "billing__get_balance", ok: true, input: { customerId: "C-77" } },
              ],
            }
      );
      expect(results["typed-triage-text"].codemode).toBe(false);
      expect(results["investigate-edit-verify"].codemode).toBe(false);
      expect(results["large-inventory"].toolDescriptorBytes).toBeGreaterThan(5000);
      expect(price.passed).toBe(true);
      expect(project).toMatchObject({
        passed: expectedStartupError === undefined,
        answer: "Fixture completed.",
        verification: "greeting checks passed",
      });
      expect(project.error).toBe(expectedStartupError);
      if (expectedStartupError === startupError) {
        expect(project.turns[1].outcomes[0]).toMatchObject({
          id: project.turns[0].decision.calls[0].id,
          ok: true,
        });
      }
      if (mode === "startup-failed-check") {
        expect(project.turns[1].outcomes[0]).toMatchObject({
          tool: "bash",
          ok: true,
          value: { exitCode: 1 },
        });
      }
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
  },
  // One child spawn with a 20_000 ms inner timeout: 20_000 + 10_000.
  30_000
);

it("runs selected cases offline in code mode through generated declarations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tubeless-eval-report-"));
  try {
    const mockPath = join(directory, "provider.mjs");
    const reportPath = join(directory, "report.json");
    await writeFile(mockPath, preload);
    execFileSync(
      process.execPath,
      [
        "--import",
        mockPath,
        "scripts/eval-agent.mjs",
        "--codemode",
        "--only=large-inventory,typed-triage-json",
        reportPath,
      ],
      {
        encoding: "utf8",
        timeout: 30_000,
        env: {
          ...process.env,
          OPENAI_API_KEY: "offline-fixture",
          OPENAI_MODEL: "offline-fixture",
          EVAL_CODEMODE: "1",
        },
      }
    );
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    expect(report.codemode).toBe(true);
    expect(report.results.map(({ id }: { id: string }) => id)).toEqual([
      "typed-triage-json",
      "large-inventory",
    ]);
    const [triage, inventory] = report.results;
    expect(triage).toMatchObject({ passed: true, toolCount: 0, codemode: false });
    expect(inventory).toMatchObject({
      passed: true,
      codemode: true,
      toolCount: 1,
      toolLog: [{ tool: "support__get_ticket" }, { tool: "billing__get_balance" }],
      output: { answer: "Balance: 1234.56 USD" },
      calls: [{ tool: "codemode" }],
    });
    expect(inventory.toolDescriptorBytes).toBeGreaterThan(5000);
    expect(inventory.outcomes[0]).toMatchObject({
      tool: "codemode",
      ok: true,
      value: { result: { customerId: "C-77", balance: 1234.56, currency: "USD" } },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  // One child spawn with a 30_000 ms inner timeout: 30_000 + 10_000.
}, 40_000);

it.each([false, true])(
  "runs Anthropic evaluations offline (codemode=%s)",
  async (codemode) => {
    const directory = await mkdtemp(join(tmpdir(), "tubeless-eval-anthropic-"));
    try {
      const mockPath = join(directory, "provider.mjs");
      const reportPath = join(directory, "report.json");
      await writeFile(mockPath, preload);
      execFileSync(
        process.execPath,
        [
          "--import",
          mockPath,
          "scripts/eval-agent.mjs",
          "--provider=anthropic",
          ...(codemode ? ["--codemode", "--only=large-inventory,typed-triage-json"] : []),
          reportPath,
        ],
        {
          encoding: "utf8",
          timeout: 30_000,
          env: {
            ...process.env,
            OPENAI_API_KEY: "",
            ANTHROPIC_API_KEY: "offline-fixture",
            ANTHROPIC_MODEL: "offline-anthropic",
            EVAL_RECOVERY: "ordered",
            EVAL_CODEMODE: codemode ? "1" : "0",
          },
        }
      );
      const report = JSON.parse(await readFile(reportPath, "utf8"));
      expect(report).toMatchObject({ provider: "anthropic", model: "offline-anthropic", codemode });
      expect(report.results.every((result: { passed: boolean }) => result.passed)).toBe(true);
      expect(report.results).toHaveLength(codemode ? 2 : 8);
      const inventory = report.results.find(
        (result: { id: string }) => result.id === "large-inventory"
      );
      expect(inventory.toolLog).toMatchObject([
        { tool: "support__get_ticket" },
        { tool: "billing__get_balance" },
      ]);
      for (const result of report.results) {
        expect(result.transcript.at(-1)).toMatchObject({
          event: { kind: "end", status: "completed" },
        });
        expect(result.turns).toHaveLength(result.turnCount);
      }
      if (!codemode) {
        const recovery = report.results.find(
          (result: { id: string }) => result.id === "recover-and-compact"
        );
        expect(recovery.compactions).toBeGreaterThan(0);
        expect(recovery.transcript).toContainEqual(
          expect.objectContaining({ event: { kind: "compaction", provider: "anthropic" } })
        );
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  40_000
);

it("fails an evaluation whose transcript omits evidence even if the agent completes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tubeless-eval-omission-"));
  try {
    const mockPath = join(directory, "provider.mjs");
    const reportPath = join(directory, "report.json");
    await writeFile(mockPath, preload);
    expect(() =>
      execFileSync(
        process.execPath,
        ["--import", mockPath, "scripts/eval-agent.mjs", "--only=typed-triage-json", reportPath],
        {
          encoding: "utf8",
          timeout: 20_000,
          env: {
            ...process.env,
            OPENAI_API_KEY: "offline-fixture",
            EVAL_RECOVERY: "transcript-omission",
          },
        }
      )
    ).toThrow();
    const { results } = JSON.parse(await readFile(reportPath, "utf8"));
    expect(results[0]).toMatchObject({
      passed: false,
      error: "Transcript evidence is incomplete or conflicting",
    });
    expect(results[0].transcript).toContainEqual(
      expect.objectContaining({ omitted: "decision", reason: "record-limit" })
    );
    expect(results[0].transcript.at(-1)).toMatchObject({
      event: { kind: "end", status: "completed" },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
