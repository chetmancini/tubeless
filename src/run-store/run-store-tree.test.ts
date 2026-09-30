import { DatabaseSync } from "node:sqlite";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PipelineTraceEvent } from "../tracing/tracing.js";
import type { PipelineRunEventQuery, StoredPipelineEvent } from "./run-store.js";
import { projectPipelineRun } from "./run-store.js";
import { openNdjsonPipelineRunStore } from "./run-store-ndjson.js";
import { openSqlitePipelineRunStore } from "./run-store-sqlite.js";
import { readPipelineEventPages, readPipelineRunTree } from "./run-store-reader.js";

const directories: string[] = [];
const sources = ["ndjson", "sqlite", "sqlite-v3", "sqlite-v4"] as const;
type Source = (typeof sources)[number];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

function started(runId: string, parentRunId?: string, pipelineId = "import"): PipelineTraceEvent {
  return {
    version: 2,
    name: "pipeline.started",
    runId,
    parentRunId,
    pipelineId,
    timestampMs: 0,
    payload: { dryRun: false, planOk: true, stepCount: 0, targetIds: [] },
  };
}

async function fixture(source: Source, events: PipelineTraceEvent[]) {
  const directory = await mkdtemp(join(tmpdir(), "tubeless-tree-"));
  directories.push(directory);
  const filename = join(directory, source === "ndjson" ? "trace.ndjson" : "runs.sqlite");
  if (source === "ndjson") {
    await writeFile(filename, events.map((event) => JSON.stringify(event)).join("\n"));
    return { filename, reader: await openNdjsonPipelineRunStore(filename) };
  }
  const writer = await openSqlitePipelineRunStore(filename);
  for (const event of events) await writer.export(event);
  await writer.close();
  if (source !== "sqlite") {
    const database = new DatabaseSync(filename);
    database.exec("DROP INDEX pipeline_run_events_parent_run_id_idx");
    if (source === "sqlite-v3")
      database.exec(
        "ALTER TABLE pipeline_run_events DROP COLUMN iteration_json; PRAGMA user_version = 3"
      );
    database.close();
  }
  return {
    filename,
    reader: await openSqlitePipelineRunStore(filename, { readOnly: true, initialize: false }),
  };
}

describe.each(sources)("%s subtree reads", (source) => {
  it("pages across interleaved runs and cycles without pruning links or changing the artifact", async () => {
    const events = [
      started("root", "grandchild"),
      started("child-a", "root"),
      started("unrelated"),
      started("child-b", "root", "publish"),
      started("grandchild", "child-a", "publish"),
      started("child-a", "root"),
      started("child-b", "root", "publish"),
      started("orphan", "unrecorded"),
    ];
    const { reader, filename } = await fixture(source, events);
    const before = await readFile(filename);
    const offset = source === "ndjson" ? 0 : 1;
    try {
      const selections: [PipelineRunEventQuery, number[]][] = [
        [{}, [0, 1, 2, 3, 4, 5, 6, 7]],
        [{ rootRunId: "root" }, [0, 1, 3, 4, 5, 6]],
        [{ rootRunId: "root", afterId: 2 + offset }, [3, 4, 5, 6]],
        [{ rootRunId: "root", pipelineId: "publish" }, [3, 4, 6]],
        [{ rootRunId: "root", runId: "child-a" }, [1, 5]],
        [{ rootRunId: "child-b", runId: "child-a" }, []],
        [{ rootRunId: "child-a" }, [0, 1, 3, 4, 5, 6]],
        [{ rootRunId: "absent" }, []],
        [{ rootRunId: "unrecorded" }, [7]],
        [{ rootRunId: "root", runId: "absent" }, []],
        [{ runId: "child-b", afterId: 3 + offset }, [6]],
        [{ runId: "child-b", pipelineId: "import" }, []],
        [{ pipelineId: "publish", afterId: 1 + offset }, [3, 4, 6]],
        [{ afterId: 7 + offset }, []],
      ];
      for (const [query, ids] of selections) {
        const collected: StoredPipelineEvent[] = [];
        for await (const page of readPipelineEventPages(reader, { ...query, limit: 1 })) {
          expect(page).toHaveLength(1);
          collected.push(...page);
        }
        expect(
          collected.map(({ id }) => id),
          JSON.stringify(query)
        ).toEqual(ids.map((id) => id + offset));
      }
      const [returned] = await reader.listEvents({ runId: "child-a" });
      returned!.parentRunId = "changed";
      expect(
        (await reader.listEvents({ rootRunId: "root", runId: "child-a" })).map(
          ({ parentRunId }) => parentRunId
        )
      ).toEqual(["root", "root"]);
    } finally {
      await reader.close();
    }
    expect(await readFile(filename)).toEqual(before);
  });

  it("reads a wide tree in a bounded number of pages, including when children precede the root", async () => {
    const children = Array.from({ length: 2000 }, (_, index) => started(`child-${index}`, "root"));
    const events = [...children, started("root"), started("unrelated")];
    const { reader } = await fixture(source, events);
    try {
      const root = projectPipelineRun(await reader.listEvents({ runId: "root" }));
      const listEvents = vi.spyOn(reader, "listEvents");
      const runs = await readPipelineRunTree(reader, root);
      expect(runs).toHaveLength(2001);
      expect(runs[0]).toBe(root);
      expect(runs.some((run) => run.runId === "unrelated")).toBe(false);
      expect(listEvents).toHaveBeenCalledTimes(2);
      expect(listEvents.mock.calls.every(([query]) => query?.rootRunId === "root")).toBe(true);
    } finally {
      await reader.close();
    }
  });
});
