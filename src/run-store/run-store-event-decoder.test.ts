import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSteps, definePipeline, requireOutputs } from "../core/pipeline.js";
import { decodeStoredTraceEvent } from "./run-store-event-decoder.js";
import { openNdjsonPipelineRunStore } from "./run-store-ndjson.js";
import { openSqlitePipelineRunStore } from "./run-store-sqlite.js";
import type { PipelineTraceEvent } from "../tracing/tracing-contracts.js";

const { step, fromPipeline, forEachPipeline, fromRemote } = createSteps();
const work = step("work-界", { run: () => 1 });
const child = definePipeline({
  id: "child",
  implementationVersion: "child-release",
  steps: [work],
});
const single = fromPipeline("single", { pipeline: child, mapOptions: () => ({}) });
const fan = forEachPipeline("fan", {
  pipeline: child,
  items: () => [1],
  key: String,
  concurrency: 2,
  mapOptions: () => ({}),
});
const remote = fromRemote("remote", {
  adapter: { engine: "test", target: "target", invoke: async () => 1 },
  mapInput: () => ({}),
  outputSchema: { "~standard": { vendor: "test", version: 1, validate: (value) => ({ value }) } },
});
const pipeline = definePipeline({
  id: "parent",
  implementationVersion: "parent-release",
  steps: [single, fan, remote],
  targets: [],
  finalize: requireOutputs([fan, single], () => 0),
});

function started(): Extract<PipelineTraceEvent, { name: "pipeline.started" }> {
  // JSON round-tripping also gives these mutation tests a mutable wire record.
  const snapshot = JSON.parse(JSON.stringify(pipeline.definition));
  return {
    version: 2,
    name: "pipeline.started",
    pipelineId: "parent",
    runId: "run-1",
    timestampMs: 1,
    payload: {
      dryRun: false,
      planOk: true,
      stepCount: 3,
      targetIds: [],
      definitionIdentity: { ...snapshot.identity },
      definitionSnapshot: snapshot,
    },
  };
}

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

const mutations = [
  {
    name: "policy",
    error: "structural fingerprint",
    mutate: (event: ReturnType<typeof started>) => {
      event.payload.definitionSnapshot!.steps[0]!.dryRun = "skip";
    },
  },
  {
    name: "targets",
    error: "structural fingerprint",
    mutate: (event: ReturnType<typeof started>) => {
      event.payload.definitionSnapshot!.targetIds = ["single"];
    },
  },
  {
    name: "required finalizer steps",
    error: "structural fingerprint",
    mutate: (event: ReturnType<typeof started>) => {
      event.payload.definitionSnapshot!.requiredFinalizerStepIds = ["single"];
    },
  },
  {
    name: "implementation version",
    error: "definition ID",
    mutate: (event: ReturnType<typeof started>) => {
      event.payload.definitionSnapshot!.identity.implementationVersion = "forged";
      event.payload.definitionIdentity = { ...event.payload.definitionSnapshot!.identity };
    },
  },
  {
    name: "definition ID",
    error: "definition ID",
    mutate: (event: ReturnType<typeof started>) => {
      event.payload.definitionSnapshot!.identity.definitionId = `sha256:${"0".repeat(64)}`;
      event.payload.definitionIdentity = { ...event.payload.definitionSnapshot!.identity };
    },
  },
  {
    name: "child definition ID",
    error: "definition ID",
    mutate: (event: ReturnType<typeof started>) => {
      event.payload.definitionSnapshot!.steps[0]!.nestedPipeline!.identity!.definitionId = `sha256:${"0".repeat(64)}`;
    },
  },
];

describe("persisted definition verification", () => {
  it("verifies composed and remote snapshots independently of object property order", () => {
    const event = started();
    const reordered = JSON.parse(JSON.stringify(event), (_key, value) =>
      value !== null && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value).reverse())
        : value
    );
    expect(decodeStoredTraceEvent(reordered)).toEqual(event);
  });

  it("keeps legacy and identity-only recordings readable", () => {
    const event = started();
    delete event.payload.definitionSnapshot;
    expect(decodeStoredTraceEvent(event)).toEqual(event);
    delete event.payload.definitionIdentity;
    expect(decodeStoredTraceEvent(event)).toEqual(event);
  });

  it.each(mutations)(
    "rejects altered $name through NDJSON and SQLite writes",
    async ({ mutate, error }) => {
      const event = started();
      mutate(event);
      expect(() => decodeStoredTraceEvent(event)).toThrow(error);
      const directory = await mkdtemp(join(tmpdir(), "tubeless-definition-validation-"));
      directories.push(directory);
      const trace = join(directory, "run.ndjson");
      await writeFile(trace, JSON.stringify(event));
      await expect(openNdjsonPipelineRunStore(trace)).rejects.toThrow(error);
      const store = await openSqlitePipelineRunStore(join(directory, "runs.sqlite"));
      expect(() => store.export(event)).toThrow(error);
      expect(() => store.close()).toThrow(error);
    }
  );

  it("rejects inconsistent snapshots already present in an imported SQLite database", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tubeless-definition-validation-"));
    directories.push(directory);
    const filename = join(directory, "runs.sqlite");
    const event = started();
    const writer = await openSqlitePipelineRunStore(filename);
    await writer.export(event);
    await writer.close();
    event.payload.definitionSnapshot!.steps[0]!.dryRun = "skip";
    const database = new DatabaseSync(filename);
    try {
      // Simulate an imported artifact; application writes cannot bypass the trigger.
      database.exec("DROP TRIGGER pipeline_run_events_no_update");
      database
        .prepare("UPDATE pipeline_run_events SET payload_json = ?")
        .run(JSON.stringify(event.payload));
    } finally {
      database.close();
    }
    const reader = await openSqlitePipelineRunStore(filename, {
      initialize: false,
      readOnly: true,
    });
    try {
      await expect(reader.listEvents()).rejects.toThrow("structural fingerprint");
    } finally {
      await reader.close();
    }
  });
});
