import { pipelineForCommand } from "../utilities/pipeline-command-marker.js";
import type { PipelineCommand } from "../cli/cli-pipeline-command.js";
import type { Pipeline } from "../core/pipeline.js";

const PIPELINE_PROJECT_MARKER = Symbol.for("tubeless/pipeline-project/v1");

export type AnyProjectPipeline = Pipeline<object, unknown, string, string, string>;

type PipelineId<TPipelines extends readonly AnyProjectPipeline[]> = TPipelines[number]["id"];

type PipelineIds<TPipelines extends readonly AnyProjectPipeline[]> = {
  readonly [TIndex in keyof TPipelines]: TPipelines[TIndex] extends AnyProjectPipeline
    ? TPipelines[TIndex]["id"]
    : never;
};

// Distribute over pipeline candidates and retain those whose possible ids overlap the lookup.
type PipelineById<
  TPipeline extends AnyProjectPipeline,
  TId extends string,
> = TPipeline extends AnyProjectPipeline
  ? string extends TPipeline["id"]
    ? TPipeline
    : [TPipeline["id"] & TId] extends [never]
      ? never
      : TPipeline
  : never;

/** Optional project presentation and CLI adapters. */
export interface ProjectOptions<
  TPipelines extends readonly AnyProjectPipeline[] = readonly AnyProjectPipeline[],
> {
  /** Display name; defaults to the project id. */
  readonly name?: string;
  /** Human-readable purpose of the project. */
  readonly description?: string;
  /** Execution directory for CLI and Studio, relative to the project file. */
  readonly cwd?: string;
  /** Explicit adapters, or a factory using project.get. */
  readonly commands?:
    | readonly PipelineCommand<{}, unknown>[]
    | ((
        get: PipelineProject<string, TPipelines>["get"]
      ) => readonly PipelineCommand<{}, unknown>[]);
}

/** Immutable named pipeline collection, preserving each pipeline's exact type by id. */
export interface PipelineProject<
  TProjectId extends string,
  TPipelines extends readonly AnyProjectPipeline[],
> {
  readonly id: TProjectId;
  readonly name: string;
  readonly description?: string;
  readonly cwd?: string;
  readonly commands: readonly PipelineCommand<{}, unknown>[];
  readonly pipelines: Readonly<TPipelines>;
  readonly pipelineIds: PipelineIds<TPipelines>;
  get<const TId extends PipelineId<TPipelines>>(id: TId): PipelineById<TPipelines[number], TId>;
}

/** Define an immutable project from existing pipelines and project configuration. */
export function defineProject<
  const TProjectId extends string,
  const TPipelines extends readonly AnyProjectPipeline[],
>(
  id: TProjectId,
  pipelines: TPipelines,
  options?: ProjectOptions<NoInfer<TPipelines>>
): PipelineProject<TProjectId, TPipelines>;
export function defineProject(
  id: string,
  pipelines: readonly AnyProjectPipeline[],
  options?: ProjectOptions
): PipelineProject<string, readonly AnyProjectPipeline[]> {
  if (typeof id !== "string" || id.trim().length === 0) {
    throw new Error("Project id must be a non-empty string.");
  }
  if (!Array.isArray(pipelines)) {
    throw new TypeError("defineProject expects an array of pipelines.");
  }

  if (
    options !== undefined &&
    (typeof options !== "object" || options === null || Array.isArray(options))
  ) {
    throw new TypeError("Project options must be an object.");
  }
  for (const field of ["name", "description", "cwd"] as const) {
    const value = options?.[field];
    if (value !== undefined && (typeof value !== "string" || value.trim().length === 0)) {
      throw new Error(`Project ${field} must be a non-empty string.`);
    }
  }
  const name = options?.name ?? id;
  const description = options?.description;
  const cwd = options?.cwd;

  const snapshot: readonly AnyProjectPipeline[] = Object.freeze([...pipelines]);
  const byId = new Map<string, AnyProjectPipeline>();
  for (const pipeline of snapshot) {
    if (byId.has(pipeline.id)) {
      throw new Error(
        `Project pipeline id ${JSON.stringify(pipeline.id)} is declared more than once.`
      );
    }
    byId.set(pipeline.id, pipeline);
  }

  const get: PipelineProject<string, readonly AnyProjectPipeline[]>["get"] = (id) => {
    const pipeline = byId.get(id);
    if (!pipeline) throw new Error(`Project does not define pipeline ${JSON.stringify(id)}.`);
    return pipeline;
  };
  const commands =
    typeof options?.commands === "function" ? options.commands(get) : (options?.commands ?? []);
  if (!Array.isArray(commands)) {
    throw new TypeError("Project commands must be an array of definePipelineCommand adapters.");
  }
  const commandIds = new Set<string>();
  for (const command of commands) {
    if (!command || !byId.has(command.id) || byId.get(command.id) !== pipelineForCommand(command)) {
      throw new Error("Each project command must wrap a pipeline in the project.");
    }
    if (commandIds.has(command.id)) {
      throw new Error(
        `Project command for ${JSON.stringify(command.id)} is declared more than once.`
      );
    }
    commandIds.add(command.id);
  }

  const project: PipelineProject<string, readonly AnyProjectPipeline[]> = {
    id,
    name,
    ...(description === undefined ? {} : { description }),
    ...(cwd === undefined ? {} : { cwd }),
    commands: Object.freeze([...commands]),
    pipelines: snapshot,
    pipelineIds: Object.freeze(snapshot.map((pipeline) => pipeline.id)),
    get,
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
