import {
  createSteps,
  definePipeline,
  requireOutputs,
  type AnyStep,
  type Pipeline,
  type PipelineExecutionContext,
  type PipelineStepContext,
  type StandardSchemaV1,
} from "../core/pipeline.js";
import { validatePipelineDocument, PipelineDocumentError } from "./project-document.js";

export { PipelineDocumentError };
export type {
  PipelineDocument,
  PipelineDocumentDefinition,
  PipelineDocumentStep,
} from "./project-document.js";

/** Dependency values are checked at runtime rather than inferred from a document. */
export type PipelineDocumentHandler = (
  inputs: Record<string, unknown>,
  context: PipelineStepContext<object>
) => unknown;

export type PipelineDocumentFinalizer = (
  outputs: Record<string, unknown>,
  context: PipelineExecutionContext<object>
) => unknown;

/** Only explicitly registered functions and schemas can be referenced by a document. */
export interface PipelineDocumentRegistry {
  steps: Readonly<Record<string, PipelineDocumentHandler>>;
  finalizers: Readonly<Record<string, PipelineDocumentFinalizer>>;
  optionsSchemas?: Readonly<Record<string, StandardSchemaV1<object, object>>>;
  schemas?: Readonly<Record<string, StandardSchemaV1>>;
}

function resolve<T>(
  registry: Readonly<Record<string, T>> | undefined,
  name: string,
  path: string
): T {
  if (!registry || !Object.hasOwn(registry, name)) {
    throw new PipelineDocumentError(path, `Unknown registered name ${JSON.stringify(name)}`);
  }
  return registry[name];
}

function handler<T extends PipelineDocumentHandler | PipelineDocumentFinalizer>(
  registry: Readonly<Record<string, T>>,
  name: string,
  path: string
): T {
  const value = resolve(registry, name, path);
  if (typeof value !== "function")
    throw new PipelineDocumentError(path, "Expected a registered function");
  return value;
}

function schema<T extends StandardSchemaV1>(
  registry: Readonly<Record<string, T>> | undefined,
  name: string | undefined,
  path: string
): T | undefined {
  if (name === undefined) return undefined;
  const value = resolve(registry, name, path);
  if (
    !value ||
    value["~standard"]?.version !== 1 ||
    typeof value["~standard"].validate !== "function"
  ) {
    throw new PipelineDocumentError(path, "Expected a Standard Schema v1 schema");
  }
  return value;
}

/**
 * Compile parsed YAML or JSON into ordinary pipelines. Does not load modules,
 * invoke handlers or schemas, or perform I/O. Graph validation belongs to core.
 */
export function compilePipelineDocument(
  document: unknown,
  registry: PipelineDocumentRegistry
): ReadonlyMap<string, Pipeline<object, unknown>> {
  const parsed = validatePipelineDocument(document);
  const pipelines = new Map<string, Pipeline<object, unknown>>();
  for (const [id, definition] of Object.entries(parsed.pipelines)) {
    const path = `$.pipelines[${JSON.stringify(id)}]`;
    const optionsSchema = schema(
      registry.optionsSchemas,
      definition.optionsSchema,
      `${path}.optionsSchema`
    );
    const step = optionsSchema ? createSteps(optionsSchema) : createSteps<object>();
    const entries = definition.steps.map((definition, index) => {
      const stepPath = `${path}.steps[${index}]`;
      // Populate these arrays after all steps exist, allowing forward references
      // and leaving cycle detection to the existing definition validator.
      const dependsOn: AnyStep[] = [];
      const optionalDependsOn: AnyStep[] = [];
      const skipAfterFailureOf: AnyStep[] = [];
      const dryRun =
        definition.dryRun === undefined || definition.dryRun === "skip"
          ? definition.dryRun
          : handler(registry.steps, definition.dryRun.run, `${stepPath}.dryRun.run`);
      const outputSchema = schema(
        registry.schemas,
        definition.outputSchema,
        `${stepPath}.outputSchema`
      );
      const config = {
        name: definition.name,
        description: definition.description,
        run: handler(registry.steps, definition.run, `${stepPath}.run`),
        dryRun,
        dependsOn,
        optionalDependsOn,
        skipAfterFailureOf,
      };
      return {
        definition,
        path: stepPath,
        dependsOn,
        optionalDependsOn,
        skipAfterFailureOf,
        step: outputSchema
          ? step(definition.id, { ...config, outputSchema })
          : step(definition.id, config),
      };
    });
    const byId = new Map(entries.map((entry) => [entry.step.id, entry.step]));
    const resolveSteps = (ids: readonly string[] = [], fieldPath: string): AnyStep[] =>
      ids.map((stepId, index) => {
        const found = byId.get(stepId);
        if (!found)
          throw new PipelineDocumentError(
            `${fieldPath}[${index}]`,
            `Unknown step ${JSON.stringify(stepId)}`
          );
        return found;
      });
    for (const entry of entries) {
      for (const field of ["dependsOn", "optionalDependsOn", "skipAfterFailureOf"] as const) {
        entry[field].push(...resolveSteps(entry.definition[field], `${entry.path}.${field}`));
      }
    }
    const finalize = handler(registry.finalizers, definition.finalize.run, `${path}.finalize.run`);
    pipelines.set(
      id,
      definePipeline({
        id,
        steps: entries.map((entry) => entry.step),
        targets: resolveSteps(definition.targets, `${path}.targets`),
        resultSchema: schema(registry.schemas, definition.resultSchema, `${path}.resultSchema`),
        finalize:
          definition.finalize.requireOutputs === undefined
            ? finalize
            : requireOutputs(
                resolveSteps(definition.finalize.requireOutputs, `${path}.finalize.requireOutputs`),
                finalize
              ),
      })
    );
  }
  return pipelines;
}
