import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTranscriptAgent } from "../../examples/agent-transcript.js";
import { openNdjsonAgentTranscriptWriter } from "../agent/ndjson-transcript.js";
import type { PipelineTraceEvent } from "../tracing/tracing-contracts.js";
import { captureIo } from "./workbench.test-support.js";
import { TUBELESS_WORKBENCH_EXIT_CODE } from "./workbench-shared.js";
import { runHistory } from "./workbench-history.js";
import { openSqlitePipelineRunStore } from "../run-store/run-store-sqlite.js";
import { runUi } from "./workbench-ui.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});
async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "tubeless-transcript-history-"));
  directories.push(cwd);
  const transcript = join(cwd, "transcript.ndjson");
  const trace = join(cwd, "trace.ndjson");
  const writer = await openNdjsonAgentTranscriptWriter(transcript);
  const events: PipelineTraceEvent[] = [];
  const agent = createTranscriptAgent({ write: writer.write });
  const run = await agent.run({ question: "hello" }, undefined, {
    tracing: {
      exporter: {
        export(event) {
          events.push(event);
        },
      },
    },
  });
  await writer.close();
  await writeFile(trace, events.map((event) => JSON.stringify(event)).join("\n"));
  return { cwd, transcript, trace, runId: run.runId, events };
}

async function recordHistory(files: Awaited<ReturnType<typeof fixture>>) {
  const filename = join(files.cwd, "runs.sqlite");
  const store = await openSqlitePipelineRunStore(filename);
  try {
    for (const event of files.events) await store.export(event);
  } finally {
    await store.close();
  }
  return filename;
}

describe("history transcript inspection", () => {
  it("reads the real capture output alongside structural history in text and JSON", async () => {
    const files = await fixture();
    const before = await readFile(files.transcript);
    const io = captureIo(files.cwd);
    expect(
      await runHistory(["--trace", files.trace, "--transcript", files.transcript, files.runId], io)
    ).toBe(0);
    expect(io.output.join("")).toContain("HELLO");
    expect(io.output.join("")).toContain("Recording: complete");
    const json = captureIo(files.cwd);
    expect(
      await runHistory(
        [
          "--json",
          "--trace",
          files.trace,
          "--transcript",
          files.transcript,
          files.runId.split(":").at(-1)!.slice(0, 8),
        ],
        json
      )
    ).toBe(0);
    const detail = JSON.parse(json.output.join(""));
    expect(detail.transcript).toMatchObject({
      runId: files.runId,
      status: "complete",
      records: expect.any(Array),
    });
    expect(detail.transcript.records).toHaveLength(5);
    expect(await readFile(files.transcript)).toEqual(before);
    const plain = captureIo(files.cwd);
    expect(await runHistory(["--json", "--trace", files.trace, files.runId], plain)).toBe(0);
    expect(JSON.parse(plain.output.join(""))).not.toHaveProperty("transcript");
  });

  it("rejects invalid flag combinations before opening or changing files", async () => {
    const { cwd, transcript, trace, runId } = await fixture();
    for (const args of [[], ["--events", runId], ["--clear", "--yes", runId]]) {
      const io = captureIo(cwd);
      expect(await runHistory(["--trace", trace, "--transcript", transcript, ...args], io)).toBe(
        TUBELESS_WORKBENCH_EXIT_CODE.usage
      );
    }
  });

  it("reports an invalid artifact as a load error without exposing its content", async () => {
    const files = await fixture();
    await writeFile(files.transcript, "{private malformed content");
    const io = captureIo(files.cwd);
    expect(
      await runHistory(["--trace", files.trace, "--transcript", files.transcript, files.runId], io)
    ).toBe(TUBELESS_WORKBENCH_EXIT_CODE.load);
    expect(io.errors.join("")).not.toContain("private malformed content");
  });

  it("imports once, reads automatically and clears stored transcripts with history", async () => {
    const files = await fixture();
    const store = await recordHistory(files);
    for (const imported of [5, 0]) {
      const io = captureIo(files.cwd);
      expect(
        await runHistory(["--store", store, "--import-transcript", files.transcript, "--json"], io)
      ).toBe(0);
      expect(JSON.parse(io.output.join(""))).toEqual({ imported });
    }
    await writeFile(files.transcript, "");
    const empty = captureIo(files.cwd);
    expect(
      await runHistory(["--store", store, "--import-transcript", files.transcript, "--json"], empty)
    ).toBe(0);
    expect(JSON.parse(empty.output.join(""))).toEqual({ imported: 0 });
    await rm(files.transcript);
    const detail = captureIo(files.cwd);
    expect(await runHistory(["--store", store, "--json", files.runId], detail)).toBe(0);
    expect(JSON.parse(detail.output.join("")).transcript).toMatchObject({
      status: "complete",
      records: expect.any(Array),
    });
    const text = captureIo(files.cwd);
    expect(await runHistory(["--store", store, files.runId], text)).toBe(0);
    expect(text.output.join("")).toContain("HELLO");

    const controller = new AbortController();
    const io = { ...captureIo(files.cwd), signal: controller.signal };
    const running = runUi(["--store", store, "--port", "0"], io);
    try {
      await vi.waitFor(
        () => expect(io.output.join("")).toContain("Tubeless local studio: http://"),
        { timeout: 10_000 }
      );
      const url = /Tubeless local studio: (http:\/\/[^\n]+)/.exec(io.output.join(""))![1];
      expect(
        await (await fetch(`${url}/api/runs/${encodeURIComponent(files.runId)}`)).json()
      ).toMatchObject({ transcriptAvailable: true });
      expect(
        await (await fetch(`${url}/api/runs/${encodeURIComponent(files.runId)}/transcript`)).json()
      ).toMatchObject({ transcript: { status: "complete" } });
      expect(await (await fetch(`${url}/api/capabilities`)).json()).toMatchObject({
        canClearHistory: true,
      });
      const cleared = await fetch(`${url}/api/history`, {
        method: "DELETE",
        headers: { "x-tubeless-studio-clear-history": "1" },
      });
      expect(cleared.status).toBe(200);
    } finally {
      controller.abort();
      await running;
    }
    const reader = await openSqlitePipelineRunStore(store, { initialize: false, readOnly: true });
    try {
      expect(await reader.listEvents()).toEqual([]);
      expect(await reader.transcripts.list({ runId: files.runId })).toMatchObject({
        records: [],
        status: "unavailable",
      });
    } finally {
      await reader.close();
    }
  }, 20_000);

  it("refuses invalid import combinations and leaves history unchanged for malformed artifacts", async () => {
    const files = await fixture();
    const store = await recordHistory(files);
    for (const extra of [
      [files.runId],
      ["--trace", files.trace],
      ["--transcript", files.transcript],
      ["--clear", "--yes"],
      ["--events"],
      ["--pipeline", "agent"],
    ]) {
      expect(
        await runHistory(["--import-transcript", files.transcript, ...extra], captureIo(files.cwd))
      ).toBe(TUBELESS_WORKBENCH_EXIT_CODE.usage);
    }
    const before = await readFile(store);
    await writeFile(files.transcript, "{private malformed content");
    const io = captureIo(files.cwd);
    expect(await runHistory(["--store", store, "--import-transcript", files.transcript], io)).toBe(
      TUBELESS_WORKBENCH_EXIT_CODE.load
    );
    expect(io.errors.join("")).not.toContain("private malformed content");
    expect(await readFile(store)).toEqual(before);
  });
});
