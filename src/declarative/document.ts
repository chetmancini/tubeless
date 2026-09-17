/** The serializable version 1 pipeline authoring format. */
export interface PipelineDocument {
  version: 1;
  pipelines: Record<string, PipelineDocumentDefinition>;
}

export interface PipelineDocumentDefinition {
  optionsSchema?: string;
  resultSchema?: string;
  targets?: readonly string[];
  steps: readonly PipelineDocumentStep[];
  finalize: { run: string; requireOutputs?: readonly string[] };
}

export interface PipelineDocumentStep {
  id: string;
  run: string;
  name?: string;
  description?: string;
  dependsOn?: readonly string[];
  optionalDependsOn?: readonly string[];
  skipAfterFailureOf?: readonly string[];
  dryRun?: "skip" | { run: string };
  outputSchema?: string;
}

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

function parseStep(value: unknown, path: string): PipelineDocumentStep {
  const step = fields(value, path, [
    "id",
    "run",
    "name",
    "description",
    "dependsOn",
    "optionalDependsOn",
    "skipAfterFailureOf",
    "dryRun",
    "outputSchema",
  ]);
  let dryRun: PipelineDocumentStep["dryRun"];
  if (step.dryRun === "skip") dryRun = "skip";
  else if (step.dryRun !== undefined) {
    const handler = fields(step.dryRun, `${path}.dryRun`, ["run"]);
    dryRun = { run: text(handler.run, `${path}.dryRun.run`) };
  }
  return {
    id: text(step.id, `${path}.id`),
    run: text(step.run, `${path}.run`),
    name: optionalText(step.name, `${path}.name`),
    description: optionalText(step.description, `${path}.description`),
    dependsOn: references(step.dependsOn, `${path}.dependsOn`),
    optionalDependsOn: references(step.optionalDependsOn, `${path}.optionalDependsOn`),
    skipAfterFailureOf: references(step.skipAfterFailureOf, `${path}.skipAfterFailureOf`),
    outputSchema: optionalText(step.outputSchema, `${path}.outputSchema`),
    dryRun,
  };
}

export function parsePipelineDocument(value: unknown): PipelineDocument {
  const document = fields(value, "$", ["version", "pipelines"]);
  if (document.version !== 1) {
    throw new PipelineDocumentError("$.version", "Expected document version 1");
  }
  const pipelines = record(document.pipelines, "$.pipelines");
  if (Object.keys(pipelines).length === 0) {
    throw new PipelineDocumentError("$.pipelines", "Expected at least one pipeline");
  }
  return {
    version: 1,
    pipelines: Object.fromEntries(
      Object.entries(pipelines).map(([id, value]) => {
        const path = `$.pipelines[${JSON.stringify(id)}]`;
        text(id, path);
        const pipeline = fields(value, path, [
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
