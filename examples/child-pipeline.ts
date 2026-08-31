import { createSteps, definePipeline } from "tubeless";

interface NormalizeOptions {
  rows: readonly string[];
}

const normalizeStep = createSteps<NormalizeOptions>();

const normalizeRows = normalizeStep("normalize-rows", {
  run: (_inputs, context) =>
    context.options.rows.map((row) => row.trim().toLowerCase()).filter((row) => row.length > 0),
});

export const NormalizePipeline = definePipeline({
  id: "normalize",
  steps: [normalizeRows],
  targets: [normalizeRows],
  finalize: (outputs) => outputs["normalize-rows"] ?? [],
});

interface ImportOptions {
  lines: readonly string[];
}

const importStep = createSteps<ImportOptions>();

const normalizedImport = importStep.fromPipeline("normalized-import", {
  pipeline: NormalizePipeline,
  mapOptions: (_inputs, context) => ({ rows: context.options.lines }),
  mapResult: (rows) => ({ count: rows.length, rows }),
});

export const ChildPipelineImport = definePipeline({
  id: "child-pipeline-import",
  steps: [normalizedImport],
  finalize: (outputs) => outputs["normalized-import"],
});

export async function runChildPipelineExample() {
  return ChildPipelineImport.runOrThrow({
    lines: [" Alpha ", "", "Beta"],
  });
}

// oxlint-disable-next-line no-constant-condition -- typecheck-only compile probe
if (false) {
  importStep.fromPipeline("invalid-child-selection", {
    pipeline: NormalizePipeline,
    // @ts-expect-error Child run options are checked against its declared target IDs.
    mapOptions: () => ({ rows: [], targets: ["normalise-rows"] }),
  });
}
