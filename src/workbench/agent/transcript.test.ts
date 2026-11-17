import { DatabaseSync } from "node:sqlite";
import { Readable } from "node:stream";
import { access, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { transcriptRecord } from "../../tracing/agent-transcript.test-support.js";
import { openSqlitePipelineRunStore } from "../../run-store/run-store-sqlite.js";
import { runWorkbenchCli } from "../workbench.js";
import { captureIo, execFileAsync, writeModule } from "../workbench.test-support.js";

async function fixture() {
  const files = await writeModule(`
    export default () => async (request, context) => {
      if (request.task === "broken") throw new Error("fixture failure");
      return context.turn === 1
        ? { conversation: null, decision: { kind: "continue", calls: [{ id: "read", tool: "read", input: { path: "sample.txt" } }] } }
        : { conversation: null, decision: { kind: "finish", result: { answer: request.task + ":read" } } };
    };
  `);
  await writeFile(join(files.directory, "sample.txt"), "private fixture content\n");
  return files;
}

async function runs(directory: string) {
  const io = captureIo(directory);
  expect(
    await runWorkbenchCli(
      ["history", "--store", "runs.sqlite", "--pipeline", "tubeless-agent", "--json"],
      io
    )
  ).toBe(0);
  return JSON.parse(io.output.join("")).runs as { runId: string; status: string }[];
}

describe("direct SQLite transcript capture", () => {
  it.each([false, true])(
    "records each prompt only with explicit capture (capture=%s)",
    async (capture) => {
      const { directory } = await fixture();
      const io = { ...captureIo(directory), stdin: Readable.from(["first\nsecond\n/quit\n"]) };
      expect(
        await runWorkbenchCli(
          [
            "agent",
            "--model-module",
            "pipeline.mjs",
            "--no-graph",
            "--store",
            "runs.sqlite",
            ...(capture ? ["--capture-transcript"] : []),
          ],
          io
        )
      ).toBe(0);
      expect(io.errors).toEqual([]);
      const saved = await runs(directory);
      expect(saved).toHaveLength(2);
      for (const run of saved) {
        const detail = captureIo(directory);
        expect(
          await runWorkbenchCli(["history", "--store", "runs.sqlite", "--json", run.runId], detail)
        ).toBe(0);
        const payload = JSON.parse(detail.output.join(""));
        if (!capture) {
          expect(payload).not.toHaveProperty("transcript");
          continue;
        }
        expect(payload.transcript).toMatchObject({ runId: run.runId, status: "complete" });
        expect(payload.transcript.records[0].sequence).toBe(1);
        expect(payload.transcript.records.at(-1).event).toEqual({
          kind: "end",
          status: "completed",
        });
        expect(payload.transcript.records).toContainEqual(
          expect.objectContaining({
            event: { kind: "call", id: "read", tool: "read", input: { path: "sample.txt" } },
          })
        );
        expect(JSON.stringify(payload.transcript.records)).toContain("private fixture content");
      }
      expect((await readdir(directory)).some((name) => name.endsWith(".ndjson"))).toBe(false);
    }
  );

  it("records failed prompts and keeps capture available for the next prompt", async () => {
    const { directory } = await fixture();
    const io = { ...captureIo(directory), stdin: Readable.from(["broken\nafter\n/quit\n"]) };
    expect(
      await runWorkbenchCli(
        [
          "agent",
          "--model-module",
          "pipeline.mjs",
          "--store",
          "runs.sqlite",
          "--capture-transcript",
          "--no-graph",
        ],
        io
      )
    ).toBe(0);
    const saved = await runs(directory);
    expect(saved.map((run) => run.status).sort()).toEqual(["completed", "failed"]);
    const store = await openSqlitePipelineRunStore(join(directory, "runs.sqlite"), {
      initialize: false,
      readOnly: true,
    });
    try {
      for (const run of saved) {
        const page = await store.transcripts.list({ runId: run.runId });
        expect(page.status).toBe("complete");
        expect(page.records.at(-1)).toMatchObject({ event: { kind: "end", status: run.status } });
      }
    } finally {
      await store.close();
    }
  });

  it("keeps sink failures private and does not fail agent execution", async () => {
    const { directory } = await fixture();
    const filename = join(directory, "runs.sqlite");
    const seed = await openSqlitePipelineRunStore(filename);
    try {
      await seed.export({
        name: "pipeline.started",
        payload: { dryRun: false, planOk: true, stepCount: 0, targetIds: [] },
        pipelineId: "seed",
        runId: "seed",
        timestampMs: 1,
        version: 3,
      });
      seed.importTranscript([transcriptRecord(1, { kind: "end", status: "completed" }, "seed")]);
    } finally {
      await seed.close();
    }
    const database = new DatabaseSync(filename);
    try {
      database.exec(`CREATE TRIGGER fail_content BEFORE INSERT ON agent_transcript_records
        BEGIN SELECT RAISE(ABORT, 'private sink failure'); END;`);
    } finally {
      database.close();
    }
    const io = captureIo(directory);
    expect(
      await runWorkbenchCli(
        [
          "agent",
          "--model-module",
          "pipeline.mjs",
          "--prompt",
          "first",
          "--store",
          "runs.sqlite",
          "--capture-transcript",
          "--no-graph",
        ],
        io
      )
    ).toBe(0);
    expect(io.output.join("")).toContain("first:read");
    expect(io.errors.join("")).toContain("Agent transcript capture disabled after a capture error");
    expect(io.errors.join("")).not.toContain("private sink failure");
    expect((await runs(directory))[0].status).toBe("completed");
  });

  it.each([
    [[], "requires --store"],
    [["missing-agent.mjs", "--store", "runs.sqlite"], "Selected agents own their configuration"],
  ] as const)(
    "rejects unsupported capture configuration before opening a destination (%j)",
    async (flags, message) => {
      const { directory } = await fixture();
      const io = captureIo(directory);
      expect(
        await runWorkbenchCli(["agent", ...flags, "--capture-transcript", "--prompt", "first"], io)
      ).toBe(1);
      expect(io.errors.join("")).toContain(message);
      await expect(access(join(directory, "runs.sqlite"))).rejects.toThrow();
    }
  );

  it("captures directly with the built Bun executable", async () => {
    const { directory } = await fixture();
    const { stdout } = await execFileAsync(
      "bun",
      [
        resolve("dist/workbench/workbench-bin.js"),
        "agent",
        "--model-module",
        resolve("examples/agent-transcript-model.ts"),
        "--prompt",
        "first",
        "--store",
        "runs.sqlite",
        "--capture-transcript",
        "--no-graph",
      ],
      { cwd: directory, env: { ...process.env, OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "" } }
    );
    expect(stdout).toContain("Listed the current directory.");
    const store = await openSqlitePipelineRunStore(join(directory, "runs.sqlite"), {
      initialize: false,
      readOnly: true,
    });
    try {
      const saved = await runs(directory);
      expect(saved).toHaveLength(1);
      for (const run of saved)
        expect(await store.transcripts.list({ runId: run.runId })).toMatchObject({
          status: "complete",
        });
    } finally {
      await store.close();
    }
  });
});
