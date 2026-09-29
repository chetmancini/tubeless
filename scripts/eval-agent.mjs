import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { defineModelAgent } from "tubeless/agent";
import { openaiModel } from "tubeless/agent/openai";

// Opt-in, paid live evaluations. Each task gets a disposable workspace and objective checks.
if (!process.env.OPENAI_API_KEY)
  throw new Error("Set OPENAI_API_KEY to run live agent evaluations");
const cases = [
  {
    id: "investigate-edit-verify",
    task: "Fix the cents conversion in price.mjs. Investigate the tests, edit the implementation, and verify the fix. Keep unrelated files and existing tests unchanged.",
    files: {
      "price.mjs": "export function cents(value) { return Math.floor(value * 100); }\n",
      "check.mjs":
        'import assert from "node:assert/strict";\nimport { cents } from "./price.mjs";\nassert.equal(cents(1.005), 101);\nassert.equal(cents(12.345), 1235);\nassert.equal(cents(0), 0);\nconsole.log("price checks passed");\n',
    },
  },
  {
    id: "project-context",
    task: "Implement greet(name) in src/greet.mjs according to the project conventions. Preserve existing tests and unrelated files; verify your implementation.",
    cwd: "src",
    files: {
      "src/AGENTS.md":
        'Greeting format is exactly "Ahoy, <trimmed name>!". Empty names use "friend". Run node ../check.mjs to verify.\n',
      "src/greet.mjs": 'export function greet(name) { return "hello"; }\n',
      "check.mjs":
        'import assert from "node:assert/strict";\nimport { greet } from "./src/greet.mjs";\nassert.equal(greet("  Ada  "), "Ahoy, Ada!");\nassert.equal(greet("  "), "Ahoy, friend!");\nconsole.log("greeting checks passed");\n',
    },
  },
  {
    id: "recover-and-compact",
    task: "Read legacy-config.json first. If it is missing, locate the current JSON configuration. Change retries to 3 without changing other settings. Keep existing tests and unrelated files unchanged, and run the checks.",
    compactAfterBytes: 1024,
    files: {
      "config/current.json":
        JSON.stringify({ retries: 0, region: "us-east-1", notes: "Keep this exact note." }) + "\n",
      "check.mjs":
        'import assert from "node:assert/strict";\nimport { readFileSync } from "node:fs";\nconst config = JSON.parse(readFileSync("config/current.json", "utf8"));\nassert.deepEqual(config, { retries: 3, region: "us-east-1", notes: "Keep this exact note." });\nconsole.log("config checks passed");\n',
    },
  },
];

const results = [];
for (const fixture of cases) {
  const root = await mkdtemp(join(tmpdir(), `tubeless-eval-${fixture.id}-`));
  const started = Date.now();
  const calls = [];
  const outcomes = [];
  let compactions = 0;
  let answer;
  let verification;
  let failure;
  try {
    await mkdir(join(root, ".git"));
    const files = {
      "AGENTS.md":
        "Read relevant source before editing. Run node check.mjs from the project root after changes. Do not modify check.mjs or unrelated.txt.\n",
      "unrelated.txt": "User work: preserve exactly.\n",
      ...fixture.files,
    };
    for (const [name, content] of Object.entries(files)) {
      await mkdir(dirname(join(root, name)), { recursive: true });
      await writeFile(join(root, name), content);
    }
    const transport = openaiModel({ compactAfterBytes: fixture.compactAfterBytes });
    const agent = defineModelAgent({
      id: fixture.id,
      limits: { maxTurns: 12, maxCalls: 24, maxDecisions: 12 },
      model: async (request, context) => {
        outcomes.push(...request.outcomes);
        const result = await transport(request, context);
        if (result.decision.kind === "continue") calls.push(...result.decision.calls);
        return result;
      },
    });
    ({ answer } = await agent.runOrThrow({ task: fixture.task }, undefined, {
      cwd: fixture.cwd ? join(root, fixture.cwd) : root,
      signal: AbortSignal.timeout(180_000),
      log: {
        log(message) {
          if (message === "Compacted agent conversation") compactions++;
        },
        warn() {},
        error() {},
      },
    }));
    for (const [name, content] of Object.entries(files)) {
      if (name === "check.mjs" || name === "unrelated.txt" || name.endsWith("AGENTS.md"))
        assert.equal(
          await readFile(join(root, name), "utf8"),
          content,
          `${name} must be preserved`
        );
    }
    verification = execFileSync(process.execPath, ["check.mjs"], {
      cwd: root,
      encoding: "utf8",
      timeout: 10_000,
    }).trim();
    assert(
      calls.some((call) => call.tool === "read"),
      "Agent must inspect files"
    );
    assert(
      calls.some((call) => call.tool === "edit" || call.tool === "write"),
      "Agent must edit files"
    );
    assert(
      outcomes.some(
        (outcome) =>
          outcome.tool === "bash" &&
          outcome.ok &&
          outcome.value.exitCode === 0 &&
          calls.some(
            (call) =>
              call.id === outcome.id &&
              call.tool === "bash" &&
              /\bnode\s+[^\n]*check\.mjs\b/.test(call.input.command)
          )
      ),
      "Agent must run the fixture check successfully"
    );
    if (fixture.compactAfterBytes) {
      assert(
        outcomes.some((outcome) => !outcome.ok && outcome.error.code === "ENOENT"),
        "Agent must observe and recover from the missing file"
      );
      assert(compactions > 0, "Conversation must compact and still complete");
    }
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  const result = {
    id: fixture.id,
    passed: failure === undefined,
    error: failure,
    answer,
    verification,
    calls,
    outcomes,
    compactions,
    durationMs: Date.now() - started,
  };
  results.push(result);
  // Keep console output short; the report retains the complete captured evidence.
  console.log(
    JSON.stringify({ ...result, calls: calls.map(({ tool }) => tool), outcomes: undefined })
  );
}
const reportPath = process.argv[2] ?? ".context/model-agent-eval.json";
await mkdir(dirname(reportPath), { recursive: true });
await writeFile(
  reportPath,
  JSON.stringify(
    {
      model: process.env.OPENAI_MODEL ?? "gpt-5.4-mini",
      completedAt: new Date().toISOString(),
      results,
    },
    null,
    2
  ) + "\n"
);
if (results.some((result) => !result.passed)) process.exitCode = 1;
