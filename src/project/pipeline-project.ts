import type { Pipeline } from "../core/pipeline.js";
import { compileValidatedPipelineDocument, type ProjectRegistry } from "./project-compiler.js";
import { validatePipelineDocument } from "./project-document.js";

const PIPELINE_PROJECT_MARKER = Symbol.for("tubeless/pipeline-project/v1");

export type AnyProjectPipeline = Pipeline<object, unknown, string, string, string>;

type PipelineId<TPipelines extends readonly AnyProjectPipeline[]> = TPipelines[number]["id"];

type PipelineIds<TPipelines extends readonly AnyProjectPipeline[]> = {
  readonly [TIndex in keyof TPipelines]: TPipelines[TIndex] extends AnyProjectPipeline
    ? TPipelines[TIndex]["id"]
    : never;
};

type PipelineById<
  TPipelines extends readonly AnyProjectPipeline[],
  TId extends PipelineId<TPipelines>,
> =
  string extends PipelineId<TPipelines>
    ? TPipelines[number]
    : Extract<TPipelines[number], { readonly id: TId }>;

/** Optional project presentation; neither field changes pipeline identity or execution. */
export interface ProjectMetadata {
  /** Display name; defaults to the project id. */
  readonly name?: string;
  /** Human-readable purpose of the project. */
  readonly description?: string;
}

/** Immutable named pipeline collection, preserving each pipeline's exact type by id. */
export interface PipelineProject<
  TProjectId extends string,
  TPipelines extends readonly AnyProjectPipeline[],
> {
  readonly id: TProjectId;
  readonly name: string;
  readonly description?: string;
  readonly pipelines: Readonly<TPipelines>;
  readonly pipelineIds: PipelineIds<TPipelines>;
  get<const TId extends PipelineId<TPipelines>>(id: TId): PipelineById<TPipelines, TId>;
}

/** Define an immutable project from typed pipelines or a parsed pipeline document. */
export function defineProject<
  const TProjectId extends string,
  const TPipelines extends readonly AnyProjectPipeline[],
>(
  id: TProjectId,
  pipelines: TPipelines,
  metadata?: ProjectMetadata
): PipelineProject<TProjectId, TPipelines>;
export function defineProject<const TProjectId extends string>(
  id: TProjectId,
  document: unknown,
  registry: ProjectRegistry,
  metadata?: ProjectMetadata
): PipelineProject<TProjectId, readonly AnyProjectPipeline[]>;
export function defineProject(
  id: string,
  pipelinesOrDocument: unknown,
  registryOrMetadata?: ProjectRegistry | ProjectMetadata,
  metadata?: ProjectMetadata
): PipelineProject<string, readonly AnyProjectPipeline[]> {
  if (typeof id !== "string" || id.trim().length === 0) {
    throw new Error("Project id must be a non-empty string.");
  }
  let pipelines: readonly AnyProjectPipeline[];
  let documentMetadata: ProjectMetadata | undefined;
  if (Array.isArray(pipelinesOrDocument)) {
    pipelines = pipelinesOrDocument;
    // The array overload takes metadata in the third position.
    metadata = registryOrMetadata as ProjectMetadata | undefined;
  } else {
    if (!registryOrMetadata || !("steps" in registryOrMetadata)) {
      throw new TypeError(
        "defineProject expects an array of pipelines, or a parsed pipeline document and registry."
      );
    }
    const document = validatePipelineDocument(pipelinesOrDocument);
    documentMetadata = document.metadata;
    pipelines = [...compileValidatedPipelineDocument(document, registryOrMetadata).values()];
  }

  if (
    metadata !== undefined &&
    (typeof metadata !== "object" || metadata === null || Array.isArray(metadata))
  ) {
    throw new TypeError("Project metadata must be an object.");
  }
  for (const field of ["name", "description"] as const) {
    const value = metadata?.[field];
    if (value !== undefined && (typeof value !== "string" || value.trim().length === 0)) {
      throw new Error(`Project ${field} must be a non-empty string.`);
    }
  }
  const name = metadata?.name ?? documentMetadata?.name ?? id;
  const description = metadata?.description ?? documentMetadata?.description;

  const byId = new Map<string, AnyProjectPipeline>();
  for (const pipeline of pipelines) {
    if (byId.has(pipeline.id)) {
      throw new Error(
        `Project pipeline id ${JSON.stringify(pipeline.id)} is declared more than once.`
      );
    }
    byId.set(pipeline.id, pipeline);
  }

  const snapshot: readonly AnyProjectPipeline[] = Object.freeze([...pipelines]);
  const project: PipelineProject<string, readonly AnyProjectPipeline[]> = {
    id,
    name,
    ...(description === undefined ? {} : { description }),
    pipelines: snapshot,
    pipelineIds: Object.freeze(snapshot.map((pipeline) => pipeline.id)),
    get(id) {
      const pipeline = byId.get(id);
      if (!pipeline) throw new Error(`Project does not define pipeline ${JSON.stringify(id)}.`);
      return pipeline;
    },
  };
  Object.defineProperty(project, PIPELINE_PROJECT_MARKER, { value: true });
  return Object.freeze(project);
}

/** Runtime guard used by the workbench when loading a project file. */
export function isPipelineProject(
  value: unknown
): value is PipelineProject<string, readonly AnyProjectPipeline[]> {
  if (typeof value !== "object" || value === null) return false;
  if (!(PIPELINE_PROJECT_MARKER in value)) return false;
  const candidate = value as { id?: unknown; pipelines?: unknown; pipelineIds?: unknown };
  return (
    typeof candidate.id === "string" &&
    Array.isArray(candidate.pipelines) &&
    Array.isArray(candidate.pipelineIds)
  );
}
