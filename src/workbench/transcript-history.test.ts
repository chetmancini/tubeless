import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { createTranscriptAgent } from "../../examples/agent-transcript.js";
import { openNdjsonAgentTranscriptWriter } from "../agent/ndjson-transcript.js";
import type { PipelineTraceEvent } from "../tracing/tracing-contracts.js";
import { captureIo } from "./workbench.test-support.js";
import { TUBELESS_WORKBENCH_EXIT_CODE } from "./workbench-shared.js";
import { runHistory } from "./workbench-history.js";

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
  return { cwd, transcript, trace, runId: run.runId };
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
});
