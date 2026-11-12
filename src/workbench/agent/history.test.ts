import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { runWorkbenchCli } from "../workbench.js";
import { captureIo } from "../workbench.test-support.js";
import { openSqlitePipelineRunStore } from "../../run-store/run-store-sqlite.js";
import type { AgentHistory } from "../../run-store/agent-history.js";
import { formatAgentHistory } from "./history.js";

it.each([
  ["agent-delegation.ts", "delegating-agent"],
  ["agent-pipeline.ts", "agent-pipeline"],
])(
  "runs %s through the CLI and inspects the same typed history from SQLite and NDJSON",
  async (filename, pipelineId) => {
    const cwd = await mkdtemp(join(tmpdir(), "tubeless-agent-history-"));
    try {
      const trace = join(cwd, "agent.ndjson");
      const database = join(cwd, "agent.sqlite");
      const example = resolve("examples", filename);
      const runIo = captureIo(cwd);
      expect(
        await runWorkbenchCli(
          [
            "run",
            "--trace",
            trace,
            "--store",
            database,
            example,
            "--",
            "--question",
            "red missing",
          ],
          runIo
        )
      ).toBe(0);
      const events = (await readFile(trace, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const runId: string = events.find(
        (event) => event.name === "pipeline.started" && !event.parentRunId
      ).runId;
      // An unrelated run in the same database must not leak into this detail view.
      const store = await openSqlitePipelineRunStore(database);
      await store.export({
        version: 2,
        name: "pipeline.started",
        pipelineId: "unrelated",
        runId: "unrelated-run",
        timestampMs: 1,
        payload: { dryRun: false, planOk: true, stepCount: 0, targetIds: [] },
      });
      await store.close();
      await writeFile(
        join(cwd, "tubeless.project.ts"),
        'throw new Error("History must not load executable modules");'
      );
      const histories: AgentHistory[] = [];
      for (const [source, filename] of [
        ["--trace", trace],
        ["--store", database],
      ]) {
        const args = ["history", source!, filename!, "--pipeline", pipelineId, runId];
        const jsonIo = captureIo(cwd);
        expect(await runWorkbenchCli([...args, "--json"], jsonIo)).toBe(0);
        const detail = JSON.parse(jsonIo.output.join(""));
        expect(detail.runId).toBe(runId);
        if (pipelineId === "agent-pipeline") expect(detail.agent).toBeUndefined();
        const history: AgentHistory = detail.agentHistory;
        histories.push(history);
        expect(history.agents).toHaveLength(3);
        const root = history.agents.find((agent) => agent.pipelineId === "delegating-agent")!;
        expect(root.termination).toBe("finish");
        expect(root.turns.map((turn) => turn.decision)).toEqual(["continue", "continue", "finish"]);
        expect(root.turns[0]!.calls.map((call) => [call.callId, call.tool])).toEqual([
          ["word-0", "processWord"],
          ["word-1", "processWord"],
        ]);
        expect(root.turns[1]!.calls[0]!.tool).toBe("summarize");
        expect(
          history.agents
            .flatMap((agent) => agent.turns)
            .flatMap((turn) => turn.calls)
            .some((call) => call.status === "failed")
        ).toBe(true);
        expect(jsonIo.output.join("")).not.toContain("unrelated-run");
        const textIo = captureIo(cwd);
        expect(await runWorkbenchCli(args, textIo)).toBe(0);
        const text = textIo.output.join("");
        expect(text).toContain("Agent history:");
        expect(text).toContain("termination finish");
        expect(text).toContain("Call word-0  tool processWord");
        expect(text).toContain("Call word-1  tool processWord");
        expect(text).toContain("NOT_FOUND");
        expect(text).toContain("state 0 -> 1");
        if (runId !== root.runId) {
          const directArgs = [
            "history",
            source!,
            filename!,
            "--pipeline",
            root.pipelineId,
            root.runId,
          ];
          const directJsonIo = captureIo(cwd);
          expect(await runWorkbenchCli([...directArgs, "--json"], directJsonIo)).toBe(0);
          const directHistory: AgentHistory = JSON.parse(directJsonIo.output.join("")).agentHistory;
          // Flat-node order may depend on selection; the nodes and rendered tree must agree.
          expect(directHistory.agents).toHaveLength(history.agents.length);
          expect(directHistory.agents).toEqual(expect.arrayContaining(history.agents));
          expect(formatAgentHistory(directHistory)).toBe(formatAgentHistory(history));
          const directTextIo = captureIo(cwd);
          expect(await runWorkbenchCli(directArgs, directTextIo)).toBe(0);
          expect(directTextIo.output.join("").split("Agent history:\n")[1]).toBe(
            text.split("Agent history:\n")[1]
          );
        }
        const rawIo = captureIo(cwd);
        expect(await runWorkbenchCli([...args, "--events"], rawIo)).toBe(0);
        expect(
          rawIo.output
            .join("")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line))
            .every((event) => event.runId === runId)
        ).toBe(true);
      }
      expect(histories[0]).toEqual(histories[1]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
  // Spawns real processes; allow for loaded CI machines.
  20_000
);

it("escapes terminal controls in call IDs and errors and labels incomplete observations", () => {
  const text = formatAgentHistory({
    agents: [
      {
        runId: "root",
        pipelineId: "agent\nspoof",
        status: "running",
        termination: "running",
        turns: [
          {
            runId: "turn",
            index: 1,
            attemptId: "attempt",
            status: "running",
            calls: [
              {
                callId: "call\u001b[31m",
                status: "unknown",
                childAgentRunIds: [],
                error: {
                  code: "TUBELESS_STEP_FAILED",
                  kind: "step",
                  phase: "execution",
                  message: "bad\nline",
                },
              },
            ],
          },
        ],
      },
    ],
  });
  expect(text).not.toContain("\u001b");
  expect(text).toContain("agent spoof");
  expect(text).toContain("bad line");
  expect(text).toContain("decision unknown");
  expect(text).toContain("run not recorded");
});

it("prints usage per agent and per run without inventing absent counters", () => {
  const text = formatAgentHistory({
    agents: [
      {
        runId: "root",
        pipelineId: "usage-agent",
        status: "completed",
        termination: "finish",
        usage: [
          {
            provider: "anthropic",
            model: "claude\u001b[31mmodel",
            requests: 2,
            requestsWithoutUsage: 2,
            durationMs: 1200.4,
            inputTokens: 112,
            uncachedInputTokens: 100,
            cacheReadTokens: 28,
            cacheWriteTokens: 7,
            outputTokens: 30,
            reasoningTokens: 5,
          },
          {
            provider: "openai",
            model: "only-requests",
            requests: 1,
            requestsWithoutUsage: 0,
            durationMs: 0,
          },
        ],
        turns: [],
      },
      {
        runId: "quiet",
        pipelineId: "quiet-agent",
        status: "completed",
        termination: "finish",
        turns: [],
      },
    ],
    usage: [
      {
        provider: "anthropic",
        model: "claude\u001b[31mmodel",
        requests: 2,
        requestsWithoutUsage: 2,
        durationMs: 1200.4,
        inputTokens: 112,
        cacheReadTokens: 28,
        outputTokens: 30,
      },
    ],
  });
  expect(text).not.toContain("\u001b");
  expect(text.split("\n").filter((line) => /^\s+Usage /.test(line))).toEqual([
    "    Usage claude [31mmodel (anthropic)  requests 2  input 112  cache read 28 (25%)  cache write 7  output 30  reasoning 5  model time 1200ms  2 without usage",
    "    Usage only-requests (openai)  requests 1  model time 0ms",
  ]);
  expect(text.split("\n").filter((line) => line.startsWith("Usage total "))).toEqual([
    "Usage total claude [31mmodel (anthropic)  requests 2  input 112  cache read 28 (25%)  output 30  model time 1200ms  2 without usage",
  ]);
});

it("omits the cache share and every usage line without counters", () => {
  const withoutCounters = formatAgentHistory({
    agents: [
      {
        runId: "root",
        pipelineId: "usage-agent",
        status: "running",
        termination: "running",
        usage: [
          {
            provider: "unknown",
            model: "model",
            requests: 1,
            requestsWithoutUsage: 0,
            durationMs: 3,
            cacheReadTokens: 4,
          },
        ],
        turns: [],
      },
    ],
  });
  expect(withoutCounters).toContain(
    "Usage model (unknown)  requests 1  cache read 4  model time 3ms"
  );
  expect(withoutCounters).not.toContain("%");
  expect(withoutCounters).not.toContain("Usage total");
  expect(
    formatAgentHistory({
      agents: [
        {
          runId: "root",
          pipelineId: "quiet-agent",
          status: "completed",
          termination: "finish",
          turns: [],
        },
      ],
    })
  ).not.toContain("Usage");
});
