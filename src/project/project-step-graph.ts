import {
  createSteps,
  type Pipeline,
  type PipelineExecutionContext,
  type StandardSchemaV1,
  type StepSkipDecision,
} from "../core/pipeline.js";
import type { AnyStep } from "../core/pipeline-steps.js";
import { PipelineDocumentError, type PipelineDocumentStep } from "./project-document.js";
import type { ProjectRegistryResolver } from "./project-registry.js";

/** Build and link one document's step graph; mutable forward-reference arrays stay local. */
export function compileDocumentSteps(
  definitions: readonly PipelineDocumentStep[],
  optionsSchema: StandardSchemaV1<object, object> | undefined,
  registry: ProjectRegistryResolver,
  resolvePipeline: (id: string, path: string) => Pipeline<object, unknown>,
  path: string
): {
  readonly steps: readonly AnyStep[];
  resolve(ids: readonly string[] | undefined, fieldPath: string): AnyStep[];
} {
  const factory = createSteps(optionsSchema);
  const entries = definitions.map((definition, index) => {
    const stepPath = `${path}.steps[${index}]`;
    // Populate these arrays after all steps exist, allowing forward references
    // and leaving cycle detection to the existing definition validator.
    const dependsOn: AnyStep[] = [];
    const optionalDependsOn: AnyStep[] = [];
    const skipAfterFailureOf: AnyStep[] = [];
    const dryRun =
      definition.dryRun === undefined || definition.dryRun === "skip"
        ? definition.dryRun
        : registry.step(definition.dryRun.run, `${stepPath}.dryRun.run`);
    const outputSchema = registry.outputSchema(definition.outputSchema, `${stepPath}.outputSchema`);
    const common = {
      name: definition.name,
      description: definition.description,
      dependsOn,
      optionalDependsOn,
      skipAfterFailureOf,
    };
    const skip = registry.skip(definition.skip, `${stepPath}.skip`);
    let built: AnyStep<object>;
    if (definition.run !== undefined) {
      const config = {
        ...common,
        dryRun,
        run: registry.step(definition.run, `${stepPath}.run`),
        skip,
      };
      built = outputSchema
        ? factory.step(definition.id, { ...config, outputSchema })
        : factory.step(definition.id, config);
    } else if (definition.fromPipeline !== undefined) {
      const reference = definition.fromPipeline;
      const adapter = registry.singleChild(reference.adapter, `${stepPath}.fromPipeline.adapter`);
      const config = {
        ...common,
        dryRun: definition.dryRun,
        pipeline: resolvePipeline(reference.pipeline, `${stepPath}.fromPipeline.pipeline`),
        controls: adapter.controls,
        mapOptions: adapter.mapOptions,
        skip,
      };
      built =
        adapter.mapResult === undefined
          ? factory.fromPipeline(definition.id, config)
          : factory.fromPipeline(definition.id, { ...config, mapResult: adapter.mapResult });
    } else {
      const reference = definition.forEachPipeline;
      const adapter = registry.mappedChild(
        reference.adapter,
        `${stepPath}.forEachPipeline.adapter`
      );
      // SAFETY: document pipelines publish unknown values. The fan-out builder
      // still represents a valued skip as the complete unknown result array.
      const fanOutSkip = skip as
        | ((
            inputs: Record<string, unknown>,
            context: PipelineExecutionContext<object>
          ) => StepSkipDecision<readonly unknown[]> | Promise<StepSkipDecision<readonly unknown[]>>)
        | undefined;
      const config = {
        ...common,
        dryRun: definition.dryRun,
        pipeline: resolvePipeline(reference.pipeline, `${stepPath}.forEachPipeline.pipeline`),
        items: adapter.items,
        key: adapter.key,
        concurrency: adapter.concurrency,
        controls: adapter.controls,
        progress: adapter.progress,
        mapOptions: adapter.mapOptions,
        skip: fanOutSkip,
      };
      built =
        adapter.mapResult === undefined
          ? factory.forEachPipeline(definition.id, config)
          : factory.forEachPipeline(definition.id, { ...config, mapResult: adapter.mapResult });
    }
    return {
      definition,
      path: stepPath,
      dependsOn,
      optionalDependsOn,
      skipAfterFailureOf,
      step: built,
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
  return { steps: entries.map(({ step }) => step), resolve: resolveSteps };
}
