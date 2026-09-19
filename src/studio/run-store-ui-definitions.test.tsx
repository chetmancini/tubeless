import { renderToString } from "preact-render-to-string";
import { describe, expect, it } from "vitest";
import { createSteps, definePipeline } from "../core/pipeline.js";
import { DefinitionHistory } from "./run-store-ui-definitions.js";
import type { StoredPipelineDefinition } from "../run-store/run-store.js";

function definition(version: string): StoredPipelineDefinition {
  const { step } = createSteps();
  const a = step("a", { run: () => 1 });
  const snapshot = definePipeline({
    id: "example",
    implementationVersion: version,
    steps: [a],
    finalize: () => 0,
  }).definition!;
  return {
    identity: snapshot.identity,
    snapshot,
    activeRuns: 0,
    firstSeenAtMs: 0,
    lastSeenAtMs: 0,
    pipelineId: "example",
    runCount: 1,
    steps: [],
    targetIds: [],
  };
}

describe("Studio definition history", () => {
  it("renders definition selection, comparison direction and implementation changes as escaped text", () => {
    const html = renderToString(
      <DefinitionHistory
        definitions={[definition("<new>"), definition("old")]}
        runs={[]}
        onSelect={() => undefined}
      />
    );
    expect(html).toContain('aria-label="Definition"');
    expect(html).toContain('aria-label="Compare from"');
    expect(html).toContain("Implementation version");
    expect(html).toContain("&lt;new>");
    expect(html).not.toContain("<new>");
    expect(html).toContain("Graph fingerprints do not verify handler code");
  });

  it("labels legacy versions and refuses to compare incomplete snapshots", () => {
    const legacy = { ...definition("old"), identity: undefined, snapshot: undefined };
    const html = renderToString(
      <DefinitionHistory
        definitions={[definition("new"), legacy]}
        runs={[]}
        onSelect={() => undefined}
      />
    );
    expect(html).toContain("Legacy (identity not recorded)");
    expect(html).toContain("A complete comparison is unavailable");
  });
});
