import { createSteps, definePipeline, requireOutputs } from "tubeless";

interface ImportOptions {
  lines: readonly string[];
}

const step = createSteps<ImportOptions>();

const loadRows = step("load-rows", {
  description: "Read raw input records from the caller.",
  run: (_inputs, context) => context.options.lines,
});

const normalizeRows = step("normalize-rows", {
  name: "Normalize Rows",
  dependsOn: [loadRows],
  description: "Normalize records after the raw rows are available.",
  run: ({ "load-rows": rows }) =>
    rows.map((row) => row.trim().toLowerCase()).filter((row) => row.length > 0),
});

export const ImportPipeline = definePipeline({
  id: "import",
  steps: [loadRows, normalizeRows],
  targets: [normalizeRows],
  finalize: requireOutputs([normalizeRows], (outputs) => ({
    count: outputs["normalize-rows"].length,
    rows: outputs["normalize-rows"],
  })),
});

export async function runImportExample() {
  return ImportPipeline.runOrThrow({
    lines: [" Alpha ", "", "Beta"],
  });
}

export function renderImportDiagram() {
  return ImportPipeline.toMermaid({ direction: "LR" });
}

export function planNormalizeTarget(lines: readonly string[]) {
  void lines;
  return ImportPipeline.plan({ targets: ["normalize-rows"] });
}

// oxlint-disable-next-line no-constant-condition -- typecheck-only compile probe
if (false) {
  // @ts-expect-error Pipeline step IDs stay literal, so typos fail typecheck.
  ImportPipeline.plan({ stepIds: ["normalise-rows"] });
  // @ts-expect-error Pipeline targets use only declared literal target IDs.
  ImportPipeline.plan({ targets: ["normalise-rows"] });
  // @ts-expect-error Existing internal step IDs are not automatically public targets.
  ImportPipeline.plan({ targets: ["load-rows"] });
}
