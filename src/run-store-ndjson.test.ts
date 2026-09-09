import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openNdjsonPipelineRunStore } from "./run-store-ndjson.js";
import type { PipelineTraceEvent } from "./tracing.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true }))
  );
});

async function tempFile(contents: string | Buffer): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "tubeless-ndjson-store-"));
  directories.push(directory);
  const filename = path.join(directory, "run.ndjson");
  await writeFile(filename, contents);
  return filename;
}

function event(runId: string, pipelineId = "import"): PipelineTraceEvent {
  return {
    attributes: { dry_run: false },
    name: "pipeline.started",
    pipelineId,
    runId,
    timestampMs: 1_700_000_000_000,
    version: 1,
  };
}

describe("openNdjsonPipelineRunStore", () => {
  it("assigns zero-based ids and supports store-compatible filters and pagination", async () => {
    const filename = await tempFile(
      `${JSON.stringify(event("run-1"))}\n\n${JSON.stringify(event("run-2", "publish"))}\n`
    );
    const store = await openNdjsonPipelineRunStore(filename);

    expect("export" in store).toBe(false);

    await expect(store.listEvents()).resolves.toMatchObject([
      { id: 0, pipelineId: "import", runId: "run-1" },
      { id: 1, pipelineId: "publish", runId: "run-2" },
    ]);
    await expect(store.listEvents({ afterId: 0 })).resolves.toMatchObject([
      { id: 1, runId: "run-2" },
    ]);
    await expect(store.listEvents({ pipelineId: "publish", runId: "run-2" })).resolves.toHaveLength(
      1
    );

    await store.close();
    await expect(store.listEvents()).rejects.toThrow("closed NDJSON pipeline run store");
  });

  it("rejects malformed events without echoing their contents", async () => {
    const secret = "do-not-repeat-this-secret";
    const filename = await tempFile(`{"token":"${secret}"}\n`);
    const invalidJson = await tempFile(`{"token":"${secret}"\n`);

    const opening = openNdjsonPipelineRunStore(filename);

    await expect(opening).rejects.toThrow(`${filename} line 1 is invalid`);
    await expect(opening).rejects.not.toThrow(secret);
    const invalidOpening = openNdjsonPipelineRunStore(invalidJson);
    await expect(invalidOpening).rejects.toThrow(`${invalidJson} line 1 is not valid JSON`);
    await expect(invalidOpening).rejects.not.toThrow(secret);
  });

  it("enforces artifact, event, and event-count limits", async () => {
    const line = JSON.stringify(event("run-1"));
    const filename = await tempFile(`${line}\n${line}\n`);

    await expect(openNdjsonPipelineRunStore(filename, { maxBytes: 10 })).rejects.toThrow(
      "10-byte NDJSON trace limit"
    );
    await expect(
      openNdjsonPipelineRunStore(filename, { maxBytes: 10_000, maxEventBytes: 10 })
    ).rejects.toThrow("10-byte event limit");
    await expect(
      openNdjsonPipelineRunStore(filename, { maxBytes: 10_000, maxEvents: 1 })
    ).rejects.toThrow("1-event NDJSON trace limit");
  });

  it("rejects invalid UTF-8", async () => {
    const filename = await tempFile(Buffer.from([0xc3, 0x28, 0x0a]));

    await expect(openNdjsonPipelineRunStore(filename)).rejects.toThrow("line 1 is not valid UTF-8");
  });
});
