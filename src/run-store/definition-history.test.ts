import { describe, expect, it } from "vitest";
import { createSteps, definePipeline, type StepCache } from "../core/pipeline.js";
import { createPipelineTestRuntime } from "../testing/testing.js";
import { decodePipelineTraceEvent } from "../tracing/tracing-codec.js";
import {
  createPipelineRunProjector,
  projectPipelineRunStore,
  type StoredPipelineEvent,
} from "./run-store.js";
import { compareDefinitions } from "./definition-diff.js";

async function record(version?: string, dryRun?: "skip", offset = 0) {
  const { step } = createSteps();
  const a = step("a", { dryRun, run: () => 1 });
  const pipeline = definePipeline({
    id: "history",
    implementationVersion: version,
    steps: [a],
    finalize: () => 0,
  });
  const events: StoredPipelineEvent[] = [];
  await pipeline.run(
    {},
    {},
    {
      ...createPipelineTestRuntime().context,
      tracing: {
        exporter: {
          export: (event) => {
            events.push({
              ...decodePipelineTraceEvent(JSON.parse(JSON.stringify(event))),
              id: offset + events.length,
            });
          },
        },
      },
    }
  );
  return { events, definition: pipeline.definition! };
}

describe("definition history", () => {
  it("groups runs by definition and keeps multiple versions across incremental reads", async () => {
    const first = await record("one");
    const second = await record("two", undefined, first.events.length);
    const third = await record("one", undefined, first.events.length + second.events.length);
    const projector = createPipelineRunProjector();
    projector.append(first.events);
    projector.append(second.events.slice(0, 1));
    expect(projector.snapshot().definitions).toHaveLength(2);
    projector.append([...second.events.slice(1), ...third.events]);
    const snapshot = projector.snapshot();
    expect(snapshot.definitions).toHaveLength(2);
    expect(
      snapshot.definitions.find(
        (definition) => definition.identity?.implementationVersion === "one"
      )
    ).toMatchObject({ runCount: 2, snapshot: first.definition });
    expect(snapshot.runs.map((run) => run.definitionIdentity!.definitionId).sort()).toEqual(
      [first, second, third].map(({ definition }) => definition.identity.definitionId).sort()
    );
    projector.clear();
    expect(projector.snapshot().definitions).toEqual([]);
  });

  it("retains definitions for empty and pre-planning failed runs", async () => {
    const pipeline = definePipeline({ id: "empty", steps: [], finalize: () => 1 });
    const events: StoredPipelineEvent[] = [];
    await pipeline.run(
      {},
      { targets: [] },
      {
        ...createPipelineTestRuntime().context,
        tracing: {
          exporter: {
            export: (event) => {
              events.push({ ...event, id: events.length });
            },
          },
        },
      }
    );
    expect(projectPipelineRunStore(events).definitions[0]).toMatchObject({
      snapshot: pipeline.definition,
      runCount: 1,
    });
  });

  it("does not invent identities for legacy traces or overwrite a version with legacy steps", async () => {
    const first = await record("one");
    const legacy = await record("two", "skip", first.events.length);
    const legacyEvents = legacy.events.map((event) => {
      if (event.name !== "pipeline.started") return event;
      const {
        definitionIdentity: _identity,
        definitionSnapshot: _snapshot,
        ...payload
      } = event.payload;
      return { ...event, payload };
    });
    const snapshot = projectPipelineRunStore([...first.events, ...legacyEvents]);
    expect(snapshot.definitions).toHaveLength(2);
    expect(snapshot.definitions.find((definition) => definition.identity)?.snapshot).toEqual(
      first.definition
    );
    expect(snapshot.definitions.find((definition) => !definition.identity)?.steps[0]?.dryRun).toBe(
      "skip"
    );
    expect(
      snapshot.runs.find((run) => run.runId === legacy.events[0]!.runId)?.definitionIdentity
    ).toBeUndefined();
  });

  it.each([
    { version: "v2", maxAge: "1 day" },
    { version: "v1", maxAge: "2 days" },
    { version: "v1", maxAge: "1 day", policy: "bypass" },
    false,
  ] satisfies (StepCache<{}> | false)[])("compares cache settings: %j", (cache) => {
    const { step } = createSteps();
    const build = (cache: StepCache<{}> | false) =>
      definePipeline({
        id: "cache-history",
        steps: [step("work", { cache, run: () => 1 })],
      }).definition;
    const before = build({ version: "v1", maxAge: "1 day" });
    const after = build(cache);
    expect(after.identity.definitionId).not.toBe(before.identity.definitionId);
    expect(compareDefinitions(before, after)).toEqual([
      {
        stepId: "work",
        field: "Cache settings",
        before: JSON.stringify(before.steps[0].cache),
        after: JSON.stringify(after.steps[0].cache),
      },
    ]);
    expect(compareDefinitions(after, before)).toEqual([
      {
        stepId: "work",
        field: "Cache settings",
        before: JSON.stringify(after.steps[0].cache),
        after: JSON.stringify(before.steps[0].cache),
      },
    ]);
  });

  it("shows implementation and policy changes independently", async () => {
    const first = await record("one");
    const second = await record("two", "skip");
    expect(compareDefinitions(first.definition, second.definition)).toEqual([
      { field: "Implementation version", before: '"one"', after: '"two"' },
      { stepId: "a", field: "Dry-run policy", before: '"run"', after: '"skip"' },
    ]);
    expect(compareDefinitions(first.definition, first.definition)).toEqual([]);
  });
});
