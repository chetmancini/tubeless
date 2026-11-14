import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { openNdjsonAgentTranscriptWriter } from "../agent/ndjson-transcript.js";
import { transcriptRecord } from "../tracing/agent-transcript.test-support.js";
import { openNdjsonAgentTranscriptReader } from "./agent-transcript-ndjson.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});
async function file() {
  const cwd = await mkdtemp(join(tmpdir(), "tubeless-transcripts-"));
  directories.push(cwd);
  return join(cwd, "saved.ndjson");
}

describe("NDJSON transcript storage", () => {
  it("serializes concurrent writes, creates private files and pages independent run sequences", async () => {
    const path = await file();
    const writer = await openNdjsonAgentTranscriptWriter(path);
    await Promise.all([
      ...Array.from({ length: 45 }, (_, index) => writer.write(transcriptRecord(index + 1))),
      writer.write(transcriptRecord(46, { kind: "end", status: "completed" })),
      writer.write(transcriptRecord(1, { kind: "assistant", text: "Other run" }, "other")),
    ]);
    await writer.close();
    await writer.close();
    await expect(writer.write(transcriptRecord())).rejects.toThrow("closed");
    expect((await stat(path)).mode & 0o077).toBe(0);
    const reader = await openNdjsonAgentTranscriptReader(path);
    const first = await reader.list({ runId: "agent:one" });
    expect(first.records).toHaveLength(20);
    expect(first).toMatchObject({ nextSequence: 20, status: "complete" });
    const second = await reader.list({ runId: "agent:one", afterSequence: 20 });
    expect(second.records[0]!.sequence).toBe(21);
    const last = await reader.list({ runId: "agent:one", afterSequence: 40 });
    expect(last.records).toHaveLength(6);
    expect(last.nextSequence).toBeUndefined();
    expect((await reader.list({ runId: "other" })).records).toHaveLength(1);
    expect((await reader.list({ runId: "unknown" })).status).toBe("unavailable");
    await reader.close();
    await expect(reader.list({ runId: "agent:one" })).rejects.toThrow("closed");
  });

  it("deduplicates identical records, preserves gaps and refuses conflicting identities", async () => {
    const path = await file();
    const records = [
      transcriptRecord(3, { kind: "end", status: "completed" }),
      transcriptRecord(1),
      transcriptRecord(1),
    ];
    await writeFile(path, records.map((record) => JSON.stringify(record)).join("\n"));
    const reader = await openNdjsonAgentTranscriptReader(path);
    const page = await reader.list({ runId: "agent:one" });
    expect(page.records.map((record) => record.sequence)).toEqual([1, 3]);
    expect(page.status).toBe("partial");
    await writeFile(
      path,
      records
        .concat({ ...transcriptRecord(), agentId: "different" })
        .map((record) => JSON.stringify(record))
        .join("\n")
    );
    await expect(openNdjsonAgentTranscriptReader(path)).rejects.toThrow("identity");
    await writeFile(
      path,
      [transcriptRecord(), transcriptRecord(1, { kind: "assistant", text: "changed" })]
        .map((record) => JSON.stringify(record))
        .join("\n")
    );
    await expect(openNdjsonAgentTranscriptReader(path)).rejects.toThrow("Conflicting");
  });

  it("keeps the opened snapshot stable and labels a byte-limit ending explicitly", async () => {
    const path = await file();
    const { event: _, ...base } = transcriptRecord(2);
    await writeFile(
      path,
      JSON.stringify(transcriptRecord()) +
        "\n" +
        JSON.stringify({ ...base, limit: "maxBytes" }) +
        "\n"
    );
    const reader = await openNdjsonAgentTranscriptReader(path);
    await writeFile(path, "changed after open");
    expect((await reader.list({ runId: "agent:one" })).status).toBe("limited");
    await reader.close();
  });

  it("rejects malformed, oversized, incomplete and invalid UTF-8 artifacts without printing content", async () => {
    const path = await file();
    for (const input of [
      "{private-content",
      JSON.stringify({ ...transcriptRecord(), version: 7 }),
      "x".repeat(65536),
      Buffer.from([0xff]),
    ]) {
      await writeFile(path, input);
      await expect(openNdjsonAgentTranscriptReader(path)).rejects.toThrow();
      try {
        await openNdjsonAgentTranscriptReader(path);
      } catch (error) {
        expect(String(error)).not.toContain("private-content");
      }
    }
    await expect(openNdjsonAgentTranscriptWriter(join(path, "child"))).rejects.toThrow();
  });

  it("rejects invalid writes and cursors without changing the artifact", async () => {
    const path = await file();
    const writer = await openNdjsonAgentTranscriptWriter(path);
    await expect(writer.write({ ...transcriptRecord(), sequence: 0 })).rejects.toThrow();
    await writer.write(transcriptRecord());
    await writer.close();
    const before = await readFile(path);
    const reader = await openNdjsonAgentTranscriptReader(path);
    for (const query of [
      { afterSequence: -1 },
      { afterSequence: NaN },
      { limit: 51 },
      { limit: 0 },
    ])
      await expect(reader.list({ runId: "agent:one", ...query })).rejects.toThrow();
    expect(await readFile(path)).toEqual(before);
    await reader.close();
  });
});
