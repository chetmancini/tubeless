import {
  createSteps,
  definePipeline,
  requireOutputs,
  type AnyStep,
  type MappedChildProgressOptions,
  type Pipeline,
  type PipelineExecutionContext,
  type PipelineRun,
  type PipelineRunOptions,
  type PipelineStepContext,
  type StandardSchemaV1,
  type StepSkipDecision,
} from "../core/pipeline.js";
import { validatePipelineDocument, PipelineDocumentError } from "./project-document.js";

export { PipelineDocumentError };

/** Dependency values are checked at runtime rather than inferred from a project document. */
type PipelineDocumentHandler = (
  inputs: Record<string, unknown>,
  context: PipelineStepContext<object>
) => unknown;

type PipelineDocumentFinalizer = (
  outputs: Record<string, unknown>,
  context: PipelineExecutionContext<object>
) => unknown;

type PipelineDocumentSkipPredicate = (
  inputs: Record<string, unknown>,
  context: PipelineExecutionContext<object>
) => StepSkipDecision | Promise<StepSkipDecision>;

/** Application-owned wiring for one declarative `fromPipeline` step. */
interface PipelineDocumentFromPipelineAdapter {
  mapOptions(
    inputs: Record<string, unknown>,
    context: PipelineExecutionContext<object>
  ): PipelineRunOptions;
  mapResult?(
    value: unknown,
    result: PipelineRun<unknown>,
    context: PipelineStepContext<object>
  ): unknown;
}

/** Application-owned wiring for one declarative `forEachPipeline` step. */
interface PipelineDocumentForEachPipelineAdapter {
  items(
    inputs: Record<string, unknown>,
    context: PipelineExecutionContext<object>
  ): readonly unknown[] | Promise<readonly unknown[]>;
  key(item: unknown, index: number): string;
  concurrency?:
    | number
    | ((inputs: Record<string, unknown>, context: PipelineExecutionContext<object>) => number);
  progress?: MappedChildProgressOptions;
  mapOptions(
    item: unknown,
    index: number,
    inputs: Record<string, unknown>,
    context: PipelineExecutionContext<object>
  ): PipelineRunOptions;
  mapResult?(
    value: unknown,
    result: PipelineRun<unknown>,
    item: unknown,
    index: number,
    context: PipelineStepContext<object>
  ): unknown;
}

/** Only explicitly registered functions and schemas can be referenced by a document. */
export interface PipelineDocumentRegistry {
  steps: Readonly<Record<string, PipelineDocumentHandler>>;
  finalizers: Readonly<Record<string, PipelineDocumentFinalizer>>;
  skipPredicates?: Readonly<Record<string, PipelineDocumentSkipPredicate>>;
  fromPipelineAdapters?: Readonly<Record<string, PipelineDocumentFromPipelineAdapter>>;
  forEachPipelineAdapters?: Readonly<Record<string, PipelineDocumentForEachPipelineAdapter>>;
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

function registeredObject<T extends object>(
  registry: Readonly<Record<string, T>> | undefined,
  name: string,
  path: string
): T {
  const value = resolve(registry, name, path);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PipelineDocumentError(path, "Expected a registered adapter object");
  }
  return value;
}

function fromPipelineAdapter(
  registry: PipelineDocumentRegistry["fromPipelineAdapters"],
  name: string,
  path: string
): PipelineDocumentFromPipelineAdapter {
  const adapter = registeredObject(registry, name, path);
  if (typeof adapter.mapOptions !== "function") {
    throw new PipelineDocumentError(path, "Expected an adapter with mapOptions");
  }
  if (adapter.mapResult !== undefined && typeof adapter.mapResult !== "function") {
    throw new PipelineDocumentError(path, "Expected adapter mapResult to be a function");
  }
  return { mapOptions: adapter.mapOptions, mapResult: adapter.mapResult };
}

function forEachPipelineAdapter(
  registry: PipelineDocumentRegistry["forEachPipelineAdapters"],
  name: string,
  path: string
): PipelineDocumentForEachPipelineAdapter {
  const adapter = registeredObject(registry, name, path);
  if (
    typeof adapter.items !== "function" ||
    typeof adapter.key !== "function" ||
    typeof adapter.mapOptions !== "function"
  ) {
    throw new PipelineDocumentError(path, "Expected an adapter with items, key, and mapOptions");
  }
  if (
    adapter.concurrency !== undefined &&
    typeof adapter.concurrency !== "number" &&
    typeof adapter.concurrency !== "function"
  ) {
    throw new PipelineDocumentError(
      path,
      "Expected adapter concurrency to be a number or function"
    );
  }
  if (adapter.mapResult !== undefined && typeof adapter.mapResult !== "function") {
    throw new PipelineDocumentError(path, "Expected adapter mapResult to be a function");
  }
  return {
    items: adapter.items,
    key: adapter.key,
    concurrency: adapter.concurrency,
    progress: adapter.progress,
    mapOptions: adapter.mapOptions,
    mapResult: adapter.mapResult,
  };
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
  const compiled = new Map<string, Pipeline<object, unknown>>();
  const compiling = new Set<string>();

  const resolvePipeline = (id: string, path: string): Pipeline<object, unknown> => {
    if (!Object.hasOwn(parsed.pipelines, id)) {
      throw new PipelineDocumentError(path, `Unknown pipeline ${JSON.stringify(id)}`);
    }
    if (compiling.has(id)) {
      throw new PipelineDocumentError(
        path,
        `Pipeline composition cycle through ${JSON.stringify(id)}`
      );
    }
    return compile(id);
  };

  const compile = (id: string): Pipeline<object, unknown> => {
    const existing = compiled.get(id);
    if (existing) return existing;
    const definition = parsed.pipelines[id]!;
    const path = `$.pipelines[${JSON.stringify(id)}]`;
    compiling.add(id);
    const optionsSchema = schema(
      registry.optionsSchemas,
      definition.optionsSchema,
      `${path}.optionsSchema`
    );
    const factory = optionsSchema ? createSteps(optionsSchema) : createSteps<object>();
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
      const common = {
        name: definition.name,
        description: definition.description,
        dependsOn,
        optionalDependsOn,
        skipAfterFailureOf,
      };
      const skip =
        definition.skip === undefined
          ? undefined
          : handler(registry.skipPredicates ?? {}, definition.skip, `${stepPath}.skip`);
      let built: AnyStep<object>;
      if (definition.run !== undefined) {
        const config = {
          ...common,
          dryRun,
          run: handler(registry.steps, definition.run, `${stepPath}.run`),
          skip,
        };
        built = outputSchema
          ? factory.step(definition.id, { ...config, outputSchema })
          : factory.step(definition.id, config);
      } else if (definition.fromPipeline !== undefined) {
        const reference = definition.fromPipeline;
        const adapter = fromPipelineAdapter(
          registry.fromPipelineAdapters,
          reference.adapter,
          `${stepPath}.fromPipeline.adapter`
        );
        const config = {
          ...common,
          dryRun: definition.dryRun,
          pipeline: resolvePipeline(reference.pipeline, `${stepPath}.fromPipeline.pipeline`),
          mapOptions: adapter.mapOptions,
          skip,
        };
        built =
          adapter.mapResult === undefined
            ? factory.fromPipeline(definition.id, config)
            : factory.fromPipeline(definition.id, { ...config, mapResult: adapter.mapResult });
      } else {
        const reference = definition.forEachPipeline;
        const adapter = forEachPipelineAdapter(
          registry.forEachPipelineAdapters,
          reference.adapter,
          `${stepPath}.forEachPipeline.adapter`
        );
        // SAFETY: document pipelines publish unknown values. The fan-out builder
        // still represents a valued skip as the complete unknown result array.
        const fanOutSkip = skip as
          | ((
              inputs: Record<string, unknown>,
              context: PipelineExecutionContext<object>
            ) =>
              | StepSkipDecision<readonly unknown[]>
              | Promise<StepSkipDecision<readonly unknown[]>>)
          | undefined;
        const config = {
          ...common,
          dryRun: definition.dryRun,
          pipeline: resolvePipeline(reference.pipeline, `${stepPath}.forEachPipeline.pipeline`),
          items: adapter.items,
          key: adapter.key,
          concurrency: adapter.concurrency,
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
    const finalize = handler(registry.finalizers, definition.finalize.run, `${path}.finalize.run`);
    const pipeline = definePipeline({
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
    });
    compiled.set(id, pipeline);
    compiling.delete(id);
    return pipeline;
  };

  return new Map(Object.keys(parsed.pipelines).map((id) => [id, compile(id)]));
}
