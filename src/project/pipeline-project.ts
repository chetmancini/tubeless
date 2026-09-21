import type { Pipeline } from "../core/pipeline.js";
import { compilePipelineDocument, type ProjectRegistry } from "./project-compiler.js";

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

export interface PipelineProject<
  TProjectId extends string,
  TPipelines extends readonly AnyProjectPipeline[],
> {
  readonly id: TProjectId;
  readonly pipelines: Readonly<TPipelines>;
  readonly pipelineIds: PipelineIds<TPipelines>;
  get<const TId extends PipelineId<TPipelines>>(id: TId): PipelineById<TPipelines, TId>;
}

/** Define an immutable project from typed pipelines or a parsed pipeline document. */
export function defineProject<
  const TProjectId extends string,
  const TPipelines extends readonly AnyProjectPipeline[],
>(id: TProjectId, pipelines: TPipelines): PipelineProject<TProjectId, TPipelines>;
export function defineProject<const TProjectId extends string>(
  id: TProjectId,
  document: unknown,
  registry: ProjectRegistry
): PipelineProject<TProjectId, readonly AnyProjectPipeline[]>;
export function defineProject(
  id: string,
  pipelinesOrDocument: unknown,
  registry?: ProjectRegistry
): PipelineProject<string, readonly AnyProjectPipeline[]> {
  if (typeof id !== "string" || id.trim().length === 0) {
    throw new Error("Project id must be a non-empty string.");
  }
  const pipelines =
    registry === undefined
      ? pipelinesOrDocument
      : [...compilePipelineDocument(pipelinesOrDocument, registry).values()];
  if (!Array.isArray(pipelines)) {
    throw new TypeError(
      "defineProject expects an array of pipelines, or a parsed pipeline document and registry."
    );
  }

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
