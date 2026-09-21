/** The serializable version 1 pipeline authoring format for project documents. */
export interface PipelineDocument {
  /** Optional editor schema association; never fetched during validation. */
  $schema?: string;
  version: 1;
  metadata?: PipelineDocumentMetadata;
  pipelines: Record<string, PipelineDocumentDefinition>;
}

/** Optional human-facing document information, never execution policy. */
export interface PipelineDocumentMetadata {
  name?: string;
  description?: string;
  authors?: readonly string[];
  /** Author-maintained date in YYYY-MM-DD format. */
  date?: string;
}

export interface PipelineDocumentDefinition {
  name?: string;
  description?: string;
  optionsSchema?: string;
  resultSchema?: string;
  targets?: readonly string[];
  steps: readonly PipelineDocumentStep[];
  finalize: { run: string; requireOutputs?: readonly string[] };
}

interface PipelineDocumentStepBase {
  id: string;
  name?: string;
  description?: string;
  dependsOn?: readonly string[];
  optionalDependsOn?: readonly string[];
  skipAfterFailureOf?: readonly string[];
  /** Name in `registry.skipPredicates`. */
  skip?: string;
}

interface PipelineDocumentRunStep extends PipelineDocumentStepBase {
  run: string;
  fromPipeline?: never;
  forEachPipeline?: never;
  dryRun?: "skip" | { run: string };
  outputSchema?: string;
}

interface PipelineDocumentFromPipelineStep extends PipelineDocumentStepBase {
  run?: never;
  /** Compose one pipeline from this document through a registered adapter. */
  fromPipeline: { pipeline: string; adapter: string };
  forEachPipeline?: never;
  dryRun?: "skip";
  outputSchema?: never;
}

interface PipelineDocumentForEachPipelineStep extends PipelineDocumentStepBase {
  run?: never;
  fromPipeline?: never;
  /** Fan out one document pipeline through a registered adapter. */
  forEachPipeline: { pipeline: string; adapter: string };
  dryRun?: "skip";
  outputSchema?: never;
}

export type PipelineDocumentStep =
  | PipelineDocumentRunStep
  | PipelineDocumentFromPipelineStep
  | PipelineDocumentForEachPipelineStep;

/** A document shape or reference error; graph errors remain PipelineDefinitionError. */
export class PipelineDocumentError extends Error {
  readonly code = "TUBELESS_DOCUMENT_INVALID";

  constructor(
    readonly path: string,
    message: string
  ) {
    super(`${path}: ${message}`);
    this.name = "PipelineDocumentError";
  }
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PipelineDocumentError(path, "Expected an object");
  }
  // SAFETY: the check above establishes a non-null, non-array object; values stay unknown.
  return value as Record<string, unknown>;
}

function fields(value: unknown, path: string, allowed: readonly string[]) {
  const object = record(value, path);
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) {
      throw new PipelineDocumentError(`${path}.${key}`, "Unknown field");
    }
  }
  return object;
}

function text(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new PipelineDocumentError(path, "Expected a non-empty string");
  }
  return value;
}

function optionalText(value: unknown, path: string): string | undefined {
  return value === undefined ? undefined : text(value, path);
}

function references(value: unknown, path: string): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new PipelineDocumentError(path, "Expected an array of names");
  return value.map((item: unknown, index) => text(item, `${path}[${index}]`));
}

function compositionReference(
  value: unknown,
  path: string
): { pipeline: string; adapter: string } | undefined {
  if (value === undefined) return undefined;
  const reference = fields(value, path, ["pipeline", "adapter"]);
  return {
    pipeline: text(reference.pipeline, `${path}.pipeline`),
    adapter: text(reference.adapter, `${path}.adapter`),
  };
}

function parseStep(value: unknown, path: string): PipelineDocumentStep {
  const step = fields(value, path, [
    "id",
    "run",
    "fromPipeline",
    "forEachPipeline",
    "name",
    "description",
    "dependsOn",
    "optionalDependsOn",
    "skipAfterFailureOf",
    "skip",
    "dryRun",
    "outputSchema",
  ]);
  const run = optionalText(step.run, `${path}.run`);
  const fromPipeline = compositionReference(step.fromPipeline, `${path}.fromPipeline`);
  const forEachPipeline = compositionReference(step.forEachPipeline, `${path}.forEachPipeline`);
  const kinds = [run, fromPipeline, forEachPipeline].filter((kind) => kind !== undefined);
  if (kinds.length !== 1) {
    throw new PipelineDocumentError(
      path,
      "Expected exactly one of run, fromPipeline, or forEachPipeline"
    );
  }
  let dryRun: PipelineDocumentRunStep["dryRun"];
  if (step.dryRun === "skip") dryRun = "skip";
  else if (step.dryRun !== undefined) {
    const handler = fields(step.dryRun, `${path}.dryRun`, ["run"]);
    dryRun = { run: text(handler.run, `${path}.dryRun.run`) };
  }
  const common = {
    id: text(step.id, `${path}.id`),
    name: optionalText(step.name, `${path}.name`),
    description: optionalText(step.description, `${path}.description`),
    dependsOn: references(step.dependsOn, `${path}.dependsOn`),
    optionalDependsOn: references(step.optionalDependsOn, `${path}.optionalDependsOn`),
    skipAfterFailureOf: references(step.skipAfterFailureOf, `${path}.skipAfterFailureOf`),
    skip: optionalText(step.skip, `${path}.skip`),
  };
  if (run !== undefined) {
    return {
      ...common,
      run,
      outputSchema: optionalText(step.outputSchema, `${path}.outputSchema`),
      dryRun,
    };
  }
  if (step.outputSchema !== undefined) {
    throw new PipelineDocumentError(
      `${path}.outputSchema`,
      "Only ordinary run steps support outputSchema"
    );
  }
  if (dryRun !== undefined && dryRun !== "skip") {
    throw new PipelineDocumentError(
      `${path}.dryRun`,
      "Composed pipeline steps only support dryRun: skip"
    );
  }
  if (fromPipeline !== undefined) return { ...common, fromPipeline, dryRun };
  // The exactly-one check above establishes this final variant.
  return { ...common, forEachPipeline: forEachPipeline!, dryRun };
}

function metadata(value: unknown): PipelineDocumentMetadata | undefined {
  if (value === undefined) return undefined;
  const entry = fields(value, "$.metadata", ["name", "description", "authors", "date"]);
  const date = optionalText(entry.date, "$.metadata.date");
  if (
    date !== undefined &&
    (!/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      !Number.isFinite(Date.parse(date)) ||
      new Date(date).toISOString().slice(0, 10) !== date)
  ) {
    throw new PipelineDocumentError("$.metadata.date", "Expected a valid YYYY-MM-DD date");
  }
  return {
    name: optionalText(entry.name, "$.metadata.name"),
    description: optionalText(entry.description, "$.metadata.description"),
    authors: references(entry.authors, "$.metadata.authors"),
    date,
  };
}

/** Validate and copy a parsed document without resolving handlers or executing code. */
export function validatePipelineDocument(value: unknown): PipelineDocument {
  const document = fields(value, "$", ["$schema", "version", "metadata", "pipelines"]);
  if (document.version !== 1) {
    throw new PipelineDocumentError("$.version", "Expected document version 1");
  }
  const pipelines = record(document.pipelines, "$.pipelines");
  if (Object.keys(pipelines).length === 0) {
    throw new PipelineDocumentError("$.pipelines", "Expected at least one pipeline");
  }
  return {
    $schema: optionalText(document.$schema, "$.$schema"),
    version: 1,
    metadata: metadata(document.metadata),
    pipelines: Object.fromEntries(
      Object.entries(pipelines).map(([id, value]) => {
        const path = `$.pipelines[${JSON.stringify(id)}]`;
        text(id, path);
        const pipeline = fields(value, path, [
          "name",
          "description",
          "optionsSchema",
          "resultSchema",
          "targets",
          "steps",
          "finalize",
        ]);
        if (!Array.isArray(pipeline.steps) || pipeline.steps.length === 0) {
          throw new PipelineDocumentError(`${path}.steps`, "Expected at least one step");
        }
        const finalize = fields(pipeline.finalize, `${path}.finalize`, ["run", "requireOutputs"]);
        return [
          id,
          {
            name: optionalText(pipeline.name, `${path}.name`),
            description: optionalText(pipeline.description, `${path}.description`),
            optionsSchema: optionalText(pipeline.optionsSchema, `${path}.optionsSchema`),
            resultSchema: optionalText(pipeline.resultSchema, `${path}.resultSchema`),
            targets: references(pipeline.targets, `${path}.targets`),
            steps: pipeline.steps.map((step: unknown, index) =>
              parseStep(step, `${path}.steps[${index}]`)
            ),
            finalize: {
              run: text(finalize.run, `${path}.finalize.run`),
              requireOutputs: references(
                finalize.requireOutputs,
                `${path}.finalize.requireOutputs`
              ),
            },
          },
        ];
      })
    ),
  };
}
