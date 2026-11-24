import { pathToFileURL } from "node:url";
import type { CliContext } from "../cli/cli.js";
import {
  isPipelineCommandContract,
  type PipelineCommandParseResult,
  type PipelineCommandContract,
} from "../cli/cli-pipeline-command-contract.js";
import type { HostablePipeline } from "../hosting/hosting-commands.js";
import { pipelineForCommand } from "../utilities/pipeline-command-marker.js";

/** Runtime surface exposed only by commands created with definePipelineCommand. */
export interface WorkbenchPipelineCommand extends PipelineCommandContract, HostablePipeline {
  parse(argv?: readonly string[], context?: Partial<CliContext>): PipelineCommandParseResult;
  run(argv?: readonly string[], context?: Partial<CliContext>): Promise<unknown>;
}

/** Runtime surface accepted by `tubeless plan`, `inspect`, and `graph`. */
export type WorkbenchPlanSource =
  | { kind: "command"; command: WorkbenchPipelineCommand }
  | { kind: "pipeline"; pipeline: HostablePipeline };

export type SelectUniqueExportOptions = {
  hintExport?: boolean;
};

function hasGraphSurface(
  value: object
): value is Pick<HostablePipeline, "stepIds" | "targetIds" | "toMermaid"> {
  return (
    "stepIds" in value &&
    Array.isArray(value.stepIds) &&
    "targetIds" in value &&
    Array.isArray(value.targetIds) &&
    "toMermaid" in value &&
    typeof value.toMermaid === "function"
  );
}

function isWorkbenchPipeline(value: unknown): value is HostablePipeline {
  if (pipelineForCommand(value)) return false;
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    "id" in value &&
    typeof value.id === "string" &&
    "plan" in value &&
    typeof value.plan === "function" &&
    hasGraphSurface(value)
  );
}

export function isWorkbenchPipelineCommand(value: unknown): value is WorkbenchPipelineCommand {
  return (
    isPipelineCommandContract(value) &&
    hasGraphSurface(value) &&
    "parse" in value &&
    typeof value.parse === "function" &&
    "run" in value &&
    typeof value.run === "function"
  );
}

function uniqueNamedExports<T>(
  moduleExports: Record<string, unknown>,
  predicate: (value: unknown) => value is T
): [string, T][] {
  const candidates = new Map<T, string>();
  for (const [name, value] of Object.entries(moduleExports)) {
    if (predicate(value) && !candidates.has(value)) candidates.set(value, name);
  }
  return Array.from(candidates, ([value, name]) => [name, value]);
}

export function selectUniqueExport<T>(
  moduleExports: Record<string, unknown>,
  exportName: string | undefined,
  predicate: (value: unknown) => value is T,
  label: string,
  options?: SelectUniqueExportOptions
) {
  if (exportName !== undefined) {
    if (!Object.prototype.hasOwnProperty.call(moduleExports, exportName)) {
      throw new Error(`Module does not export ${JSON.stringify(exportName)}.`);
    }
    const selected = moduleExports[exportName];
    if (!predicate(selected)) {
      throw new Error(`Export ${JSON.stringify(exportName)} is not a tubeless ${label}.`);
    }
    return { exportName, value: selected };
  }

  const unique = uniqueNamedExports(moduleExports, predicate);
  if (unique.length === 0) {
    throw new Error(`Module does not export a tubeless ${label}.`);
  }
  if (unique.length > 1) {
    const names = unique.map(([name]) => name).join(", ");
    const hint = options?.hintExport === false ? "" : "; pass --export <name>";
    throw new Error(`Module exports multiple ${label}s (${names})${hint}.`);
  }
  const [name, value] = unique[0];
  return { exportName: name, value };
}

function selectPlanSourceExport(
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
      `Export ${JSON.stringify(exportName)} is not a tubeless pipeline or pipeline command.`
    );
  }

  const commands = uniqueNamedExports(moduleExports, isWorkbenchPipelineCommand);
  if (commands.length === 1) {
    return { kind: "command", command: commands[0][1] };
  }
  if (commands.length > 1) {
    throw new Error(
      `Module exports multiple pipeline commands (${commands.map(([name]) => name).join(", ")}); pass --export <name>.`
    );
  }

  const pipelines = uniqueNamedExports(moduleExports, isWorkbenchPipeline);
  if (pipelines.length === 1) {
    return { kind: "pipeline", pipeline: pipelines[0][1] };
  }
  if (pipelines.length > 1) {
    throw new Error(
      `Module exports multiple pipelines (${pipelines.map(([name]) => name).join(", ")}); pass --export <name>.`
    );
  }
  throw new Error("Module does not export a tubeless pipeline or pipeline command.");
}

export async function importModuleNamespace(filePath: string): Promise<Record<string, unknown>> {
  // SAFETY: a dynamic import of a JS/TS module always yields a module namespace
  // object whose exports are string-keyed values, so the cast to
  // Record<string, unknown> documents the import result's shape; selectors
  // validate each export at runtime before use.
  return (await import(pathToFileURL(filePath).href)) as Record<string, unknown>;
}

export async function loadPlanSourceModule(
  filePath: string,
  exportName?: string
): Promise<WorkbenchPlanSource> {
  return selectPlanSourceExport(await importModuleNamespace(filePath), exportName);
}
