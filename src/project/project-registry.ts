import type {
  MappedChildProgressOptions,
  PipelineExecutionContext,
  PipelineRun,
  PipelineRunControls,
  PipelineStepContext,
  StandardSchemaV1,
  StepSkipDecision,
} from "../core/pipeline.js";
import { PipelineDocumentError } from "./project-document.js";

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
  controls?:
    | PipelineRunControls
    | ((
        inputs: Record<string, unknown>,
        context: PipelineExecutionContext<object>
      ) => PipelineRunControls);
  mapOptions(inputs: Record<string, unknown>, context: PipelineExecutionContext<object>): object;
  mapResult?(
    value: unknown,
    result: PipelineRun<unknown>,
    context: PipelineStepContext<object>
  ): unknown;
}

/** Application-owned wiring for one declarative `forEachPipeline` step. */
interface PipelineDocumentForEachPipelineAdapter {
  controls?:
    | PipelineRunControls
    | ((
        item: unknown,
        index: number,
        inputs: Record<string, unknown>,
        context: PipelineExecutionContext<object>
      ) => PipelineRunControls);
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
  ): object;
  mapResult?(
    value: unknown,
    result: PipelineRun<unknown>,
    item: unknown,
    index: number,
    context: PipelineStepContext<object>
  ): unknown;
}

/** Only explicitly registered functions and schemas can be referenced by a document. */
export interface ProjectRegistry {
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

function validateAdapterMapping(
  adapter: { controls?: unknown; mapResult?: unknown },
  path: string
): void {
  if (
    adapter.controls !== undefined &&
    typeof adapter.controls !== "function" &&
    (typeof adapter.controls !== "object" || adapter.controls === null)
  ) {
    throw new PipelineDocumentError(path, "Expected adapter controls to be an object or function");
  }
  if (adapter.mapResult !== undefined && typeof adapter.mapResult !== "function") {
    throw new PipelineDocumentError(path, "Expected adapter mapResult to be a function");
  }
}

function fromPipelineAdapter(
  registry: ProjectRegistry["fromPipelineAdapters"],
  name: string,
  path: string
): PipelineDocumentFromPipelineAdapter {
  const adapter = registeredObject(registry, name, path);
  if (typeof adapter.mapOptions !== "function") {
    throw new PipelineDocumentError(path, "Expected an adapter with mapOptions");
  }
  validateAdapterMapping(adapter, path);
  return {
    controls: adapter.controls,
    mapOptions: adapter.mapOptions,
    mapResult: adapter.mapResult,
  };
}

function forEachPipelineAdapter(
  registry: ProjectRegistry["forEachPipelineAdapters"],
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
  validateAdapterMapping(adapter, path);
  return {
    items: adapter.items,
    key: adapter.key,
    controls: adapter.controls,
    concurrency: adapter.concurrency,
    progress: adapter.progress,
    mapOptions: adapter.mapOptions,
    mapResult: adapter.mapResult,
  };
}

/** Resolve application wiring without constructing pipelines or invoking application code. */
export class ProjectRegistryResolver {
  readonly #registry: ProjectRegistry;

  constructor(registry: ProjectRegistry) {
    this.#registry = registry;
  }

  step(name: string, path: string): PipelineDocumentHandler {
    return handler(this.#registry.steps, name, path);
  }

  finalizer(name: string, path: string): PipelineDocumentFinalizer {
    return handler(this.#registry.finalizers, name, path);
  }

  skip(name: string | undefined, path: string): PipelineDocumentSkipPredicate | undefined {
    return name === undefined
      ? undefined
      : handler(this.#registry.skipPredicates ?? {}, name, path);
  }

  optionsSchema(
    name: string | undefined,
    path: string
  ): StandardSchemaV1<object, object> | undefined {
    return schema(this.#registry.optionsSchemas, name, path);
  }

  outputSchema(name: string | undefined, path: string): StandardSchemaV1 | undefined {
    return schema(this.#registry.schemas, name, path);
  }

  singleChild(name: string, path: string): PipelineDocumentFromPipelineAdapter {
    return fromPipelineAdapter(this.#registry.fromPipelineAdapters, name, path);
  }

  mappedChild(name: string, path: string): PipelineDocumentForEachPipelineAdapter {
    return forEachPipelineAdapter(this.#registry.forEachPipelineAdapters, name, path);
  }
}
