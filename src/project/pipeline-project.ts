import type { Pipeline } from "../core/pipeline.js";
import { compilePipelineDocument, type ProjectRegistry } from "./project-compiler.js";

type AnyPipeline = Pipeline<object, unknown, string, string, string>;

type PipelineId<TPipelines extends readonly AnyPipeline[]> = TPipelines[number]["id"];

type PipelineIds<TPipelines extends readonly AnyPipeline[]> = {
  readonly [TIndex in keyof TPipelines]: TPipelines[TIndex] extends AnyPipeline
    ? TPipelines[TIndex]["id"]
    : never;
};

type PipelineById<TPipelines extends readonly AnyPipeline[], TId extends PipelineId<TPipelines>> =
  string extends PipelineId<TPipelines>
    ? TPipelines[number]
    : Extract<TPipelines[number], { readonly id: TId }>;

interface PipelineProject<TProjectId extends string, TPipelines extends readonly AnyPipeline[]> {
  readonly id: TProjectId;
  readonly pipelines: Readonly<TPipelines>;
  readonly pipelineIds: PipelineIds<TPipelines>;
  get<const TId extends PipelineId<TPipelines>>(id: TId): PipelineById<TPipelines, TId>;
}

/** Define an immutable project from typed pipelines or a parsed pipeline document. */
export function defineProject<
  const TProjectId extends string,
  const TPipelines extends readonly AnyPipeline[],
>(id: TProjectId, pipelines: TPipelines): PipelineProject<TProjectId, TPipelines>;
export function defineProject<const TProjectId extends string>(
  id: TProjectId,
  document: unknown,
  registry: ProjectRegistry
): PipelineProject<TProjectId, readonly AnyPipeline[]>;
export function defineProject(
  id: string,
  pipelinesOrDocument: unknown,
  registry?: ProjectRegistry
): PipelineProject<string, readonly AnyPipeline[]> {
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

  const byId = new Map<string, AnyPipeline>();
  for (const pipeline of pipelines) {
    if (byId.has(pipeline.id)) {
      throw new Error(
        `Project pipeline id ${JSON.stringify(pipeline.id)} is declared more than once.`
      );
    }
    byId.set(pipeline.id, pipeline);
  }

  const snapshot: readonly AnyPipeline[] = Object.freeze([...pipelines]);
  const project: PipelineProject<string, readonly AnyPipeline[]> = {
    id,
    pipelines: snapshot,
    pipelineIds: Object.freeze(snapshot.map((pipeline) => pipeline.id)),
    get(id) {
      const pipeline = byId.get(id);
      if (!pipeline) throw new Error(`Project does not define pipeline ${JSON.stringify(id)}.`);
      return pipeline;
    },
  };
  return Object.freeze(project);
}
