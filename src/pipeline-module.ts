import { pathToFileURL } from "node:url";
import type { CliCommandDescriptor, CliContext, PipelineCommandPlanInput } from "./cli.js";
import { isMarkedPipelineCommand } from "./pipeline-command-marker.js";
import type { PipelineMermaidOptions, PipelinePlan, PipelineRunControls } from "./pipeline.js";

/** Runtime surface required by the workbench's non-executing pipeline commands. */
export interface WorkbenchPipeline {
  readonly id: string;
  readonly stepIds: readonly string[];
  readonly targetIds: readonly string[];
  plan(controls?: PipelineRunControls): PipelinePlan;
  toMermaid(options?: PipelineMermaidOptions): string;
}

/** Runtime surface exposed only by commands created with definePipelineCommand. */
export type WorkbenchPipelineCommandParseResult =
  | { kind: "values"; values: Record<string, unknown> }
  | { kind: "help"; helpText: string }
  | { kind: "error"; errors: readonly string[]; helpText: string };

export interface WorkbenchPipelineCommand {
  readonly descriptor: CliCommandDescriptor;
  readonly id: string;
  readonly stepIds: readonly string[];
  readonly targetIds: readonly string[];
  parse(
    argv?: readonly string[],
    context?: Partial<CliContext>
  ): WorkbenchPipelineCommandParseResult;
  plan(input?: PipelineCommandPlanInput): PipelinePlan;
  run(argv?: readonly string[], context?: Partial<CliContext>): Promise<unknown>;
  toMermaid(options?: PipelineMermaidOptions): string;
}

/** Runtime surface accepted by `tubeless plan`, `inspect`, and `graph`. */
export type WorkbenchPlanSource =
  | { kind: "command"; command: WorkbenchPipelineCommand }
  | { kind: "pipeline"; pipeline: WorkbenchPipeline };

function isWorkbenchPipeline(value: unknown): value is WorkbenchPipeline {
  if (isMarkedPipelineCommand(value)) return false;
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    "id" in value &&
    typeof value.id === "string" &&
    "stepIds" in value &&
    Array.isArray(value.stepIds) &&
    "targetIds" in value &&
    Array.isArray(value.targetIds) &&
    "plan" in value &&
    typeof value.plan === "function" &&
    "toMermaid" in value &&
    typeof value.toMermaid === "function"
  );
}

function isWorkbenchPipelineCommand(value: unknown): value is WorkbenchPipelineCommand {
  if (!isMarkedPipelineCommand(value)) return false;
  // SAFETY: isMarkedPipelineCommand established value is a non-null object or
  // function, so this single cast only widens to a shape we probe with `in`.
  const candidate = value as object;
  return (
    "descriptor" in candidate &&
    typeof candidate.descriptor === "object" &&
    candidate.descriptor !== null &&
    "id" in candidate &&
    typeof candidate.id === "string" &&
    "stepIds" in candidate &&
    Array.isArray(candidate.stepIds) &&
    "targetIds" in candidate &&
    Array.isArray(candidate.targetIds) &&
    "plan" in candidate &&
    typeof candidate.plan === "function" &&
    "parse" in candidate &&
    typeof candidate.parse === "function" &&
    "run" in candidate &&
    typeof candidate.run === "function" &&
    "toMermaid" in candidate &&
    typeof candidate.toMermaid === "function"
  );
}

function selectUniqueExport<T>(
  moduleExports: Record<string, unknown>,
  exportName: string | undefined,
  predicate: (value: unknown) => value is T,
  label: string
): T {
  if (exportName !== undefined) {
    if (!Object.prototype.hasOwnProperty.call(moduleExports, exportName)) {
      throw new Error(`Module does not export ${JSON.stringify(exportName)}.`);
    }
    const selected = moduleExports[exportName];
    if (!predicate(selected)) {
      throw new Error(`Export ${JSON.stringify(exportName)} is not an tubeless ${label}.`);
    }
    return selected;
  }

  const candidates = Object.entries(moduleExports).filter((entry): entry is [string, T] =>
    predicate(entry[1])
  );
  const unique = candidates.filter(
    ([, value], index) => candidates.findIndex(([, other]) => other === value) === index
  );

  if (unique.length === 0) {
    throw new Error(`Module does not export an tubeless ${label}.`);
  }
  if (unique.length > 1) {
    throw new Error(
      `Module exports multiple ${label}s (${unique.map(([name]) => name).join(", ")}); pass --export <name>.`
    );
  }
  return unique[0]![1];
}

/** Select one real pipeline from a loaded module, deduplicating export aliases. */
export function selectPipelineExport(
  moduleExports: Record<string, unknown>,
  exportName?: string
): WorkbenchPipeline {
  return selectUniqueExport(moduleExports, exportName, isWorkbenchPipeline, "pipeline");
}

/** Select one definePipelineCommand export, deduplicating export aliases. */
export function selectPipelineCommandExport(
  moduleExports: Record<string, unknown>,
  exportName?: string
): WorkbenchPipelineCommand {
  return selectPipelineCommandExportWithName(moduleExports, exportName).command;
}

/** Select one command and retain the stable name of the export that selected it. */
export function selectPipelineCommandExportWithName(
  moduleExports: Record<string, unknown>,
  exportName?: string
) {
  if (exportName !== undefined) {
    if (!Object.prototype.hasOwnProperty.call(moduleExports, exportName)) {
      throw new Error(`Module does not export ${JSON.stringify(exportName)}.`);
    }
    const selected = moduleExports[exportName];
    if (!isWorkbenchPipelineCommand(selected)) {
      throw new Error(`Export ${JSON.stringify(exportName)} is not an tubeless pipeline command.`);
    }
    return { command: selected, exportName };
  }
  const candidates = uniqueNamedExports(moduleExports, isWorkbenchPipelineCommand);
  if (candidates.length === 0) {
    throw new Error("Module does not export an tubeless pipeline command.");
  }
  if (candidates.length > 1) {
    throw new Error(
      `Module exports multiple pipeline commands (${candidates.map(([name]) => name).join(", ")}); pass --export <name>.`
    );
  }
  return { command: candidates[0]![1], exportName: candidates[0]![0] };
}

function uniqueNamedExports<T>(
  moduleExports: Record<string, unknown>,
  predicate: (value: unknown) => value is T
): [string, T][] {
  const candidates = Object.entries(moduleExports).filter((entry): entry is [string, T] =>
    predicate(entry[1])
  );
  return candidates.filter(
    ([, value], index) => candidates.findIndex(([, other]) => other === value) === index
  );
}

/**
 * Select a plan source. A marked command wins when the module also exports a
 * pipeline. Named exports still have to be a pipeline or a marked command.
 */
export function selectPlanSourceExport(
  moduleExports: Record<string, unknown>,
  exportName?: string
): WorkbenchPlanSource {
  if (exportName !== undefined) {
    if (!Object.prototype.hasOwnProperty.call(moduleExports, exportName)) {
      throw new Error(`Module does not export ${JSON.stringify(exportName)}.`);
    }
    const selected = moduleExports[exportName];
    if (isWorkbenchPipelineCommand(selected)) {
      return { kind: "command", command: selected };
    }
    if (isWorkbenchPipeline(selected)) {
      return { kind: "pipeline", pipeline: selected };
    }
    throw new Error(
      `Export ${JSON.stringify(exportName)} is not an tubeless pipeline or pipeline command.`
    );
  }

  const commands = uniqueNamedExports(moduleExports, isWorkbenchPipelineCommand);
  if (commands.length === 1) {
    return { kind: "command", command: commands[0]![1] };
  }
  if (commands.length > 1) {
    throw new Error(
      `Module exports multiple pipeline commands (${commands.map(([name]) => name).join(", ")}); pass --export <name>.`
    );
  }

  const pipelines = uniqueNamedExports(moduleExports, isWorkbenchPipeline);
  if (pipelines.length === 1) {
    return { kind: "pipeline", pipeline: pipelines[0]![1] };
  }
  if (pipelines.length > 1) {
    throw new Error(
      `Module exports multiple pipelines (${pipelines.map(([name]) => name).join(", ")}); pass --export <name>.`
    );
  }
  throw new Error("Module does not export an tubeless pipeline or pipeline command.");
}

/** Load and select a pipeline from an absolute module path. */
export async function loadPipelineModule(
  filePath: string,
  exportName?: string
): Promise<WorkbenchPipeline> {
  // SAFETY: a dynamic import of a JS/TS module always yields a module namespace
  // object whose exports are string-keyed values, so the cast to
  // Record<string, unknown> documents the import result's shape; selectors
  // validate each export at runtime before use.
  const moduleExports = (await import(pathToFileURL(filePath).href)) as Record<string, unknown>;
  return selectPipelineExport(moduleExports, exportName);
}

/** Load and select a pipeline command from an absolute module path. */
export async function loadPipelineCommandModule(
  filePath: string,
  exportName?: string
): Promise<WorkbenchPipelineCommand> {
  // SAFETY: a dynamic import of a JS/TS module always yields a module namespace
  // object whose exports are string-keyed values, so the cast to
  // Record<string, unknown> documents the import result's shape; selectors
  // validate each export at runtime before use.
  const moduleExports = (await import(pathToFileURL(filePath).href)) as Record<string, unknown>;
  return selectPipelineCommandExport(moduleExports, exportName);
}

/** Load a command and its export name for a stable external registration identity. */
export async function loadPipelineCommandModuleWithName(
  filePath: string,
  exportName?: string
): Promise<{ command: WorkbenchPipelineCommand; exportName: string }> {
  // SAFETY: a dynamic import of a JS/TS module always yields a module namespace
  // object whose exports are string-keyed values, so the cast to
  // Record<string, unknown> documents the import result's shape; selectors
  // validate each export at runtime before use.
  const moduleExports = (await import(pathToFileURL(filePath).href)) as Record<string, unknown>;
  return selectPipelineCommandExportWithName(moduleExports, exportName);
}

/** Load a marked command when present, otherwise a pipeline, for inspect/plan/graph. */
export async function loadPlanSourceModule(
  filePath: string,
  exportName?: string
): Promise<WorkbenchPlanSource> {
  // SAFETY: a dynamic import of a JS/TS module always yields a module namespace
  // object whose exports are string-keyed values, so the cast to
  // Record<string, unknown> documents the import result's shape; selectors
  // validate each export at runtime before use.
  const moduleExports = (await import(pathToFileURL(filePath).href)) as Record<string, unknown>;
  return selectPlanSourceExport(moduleExports, exportName);
}
