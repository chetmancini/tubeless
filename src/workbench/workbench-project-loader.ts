import { stat } from "node:fs/promises";
import * as path from "node:path";
import {
  importModuleNamespace,
  selectUniqueExport,
  type WorkbenchPipeline,
  type WorkbenchPipelineCommand,
} from "./pipeline-module.js";
import { definePipelineCommand } from "../cli/cli-pipeline-command.js";
import {
  isCommandCatalog,
  type CommandCatalog,
  type CommandCatalogEntry,
} from "../cli/command-catalog.js";
import {
  isPipelineProject,
  type AnyProjectPipeline,
  type PipelineProject,
} from "../project/pipeline-project.js";
import {
  errorMessage,
  loadPipelineCommand,
  loadPlanSource,
  TUBELESS_WORKBENCH_EXIT_CODE,
  writeUsageError,
  type WorkbenchCliIo,
} from "./workbench-shared.js";

/** Default project file checked in the invocation directory. No parent search is performed. */
export const DEFAULT_PIPELINE_PROJECT_FILE = "tubeless.project.ts";

interface LoadedCommandCatalog {
  filePath: string;
  kind: "catalog";
  manifest: CommandCatalog;
}

interface LoadedPipelineProject {
  filePath: string;
  kind: "project";
  project: PipelineProject<string, readonly AnyProjectPipeline[]>;
}

export type LoadedPipelineProjectFile = LoadedCommandCatalog | LoadedPipelineProject;

interface ResolvedCommandModule {
  cwd: string;
  exportName?: string;
  filePath: string;
  id: string;
  kind: "module";
  name?: string;
}

interface ResolvedProjectPipeline {
  cwd: string;
  id: string;
  kind: "pipeline";
  pipeline: AnyProjectPipeline;
}

export type ResolvedPipelineProjectCommand = ResolvedCommandModule | ResolvedProjectPipeline;

type LoadFailure = { exitCode: number };

const EXPORT_PROJECT_MUTEX_ERROR =
  "--export cannot be combined with --project; the project file owns export selection.";

function inferProjectPipelineCommand(
  registration: ResolvedProjectPipeline,
  io: WorkbenchCliIo
): WorkbenchPipelineCommand | LoadFailure {
  try {
    return definePipelineCommand(registration.pipeline);
  } catch (error) {
    io.stderr.write(
      `Error: Cannot derive a CLI for project pipeline ${JSON.stringify(registration.id)}: ${errorMessage(error)}\n`
    );
    return { exitCode: TUBELESS_WORKBENCH_EXIT_CODE.load };
  }
}

type ResolvedTargetLoad =
  | {
      exportName: string | undefined;
      fileArgument: string;
      kind: "module";
      loadIo: WorkbenchCliIo;
      registration?: ResolvedCommandModule;
    }
  | {
      kind: "pipeline";
      loadIo: WorkbenchCliIo;
      registration: ResolvedProjectPipeline;
    };

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

/** Load one explicitly named project file without searching parent directories. */
export async function loadPipelineProjectFile(
  fileArgument: string,
  io: WorkbenchCliIo
): Promise<LoadedPipelineProjectFile | LoadFailure> {
  const filePath = path.resolve(io.cwd, fileArgument);
  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) throw new Error(`${filePath} is not a file.`);
    const moduleExports = await importModuleNamespace(filePath);
    const hasCatalog = Object.values(moduleExports).some(isCommandCatalog);
    if (!hasCatalog) {
      const project = selectUniqueExport(moduleExports, undefined, isPipelineProject, "project", {
        hintExport: false,
      }).value;
      return { filePath, kind: "project", project };
    }

    const manifest = selectUniqueExport(
      moduleExports,
      undefined,
      isCommandCatalog,
      "command catalog",
      {
        hintExport: false,
      }
    ).value;
    const moduleIdentities = new Set<string>();
    for (const command of manifest.commands) {
      const moduleIdentity = `${path.resolve(path.dirname(filePath), command.file)}\0${command.export ?? ""}`;
      if (moduleIdentities.has(moduleIdentity)) {
        throw new Error(
          `Command catalog entry ${JSON.stringify(command.file)}${command.export ? ` export ${JSON.stringify(command.export)}` : ""} resolves to a duplicate module registration.`
        );
      }
      moduleIdentities.add(moduleIdentity);
    }
    return { filePath, kind: "catalog", manifest };
  } catch (error) {
    io.stderr.write(`Error: ${errorMessage(error)}\n`);
    return { exitCode: TUBELESS_WORKBENCH_EXIT_CODE.load };
  }
}

/** Resolve one stable pipeline or command id from a loaded project file. */
function resolvePipelineProjectCommand(
  loaded: LoadedPipelineProjectFile,
  id: string,
  io: WorkbenchCliIo
): ResolvedPipelineProjectCommand | LoadFailure {
  if (loaded.kind === "project") {
    const pipeline = loaded.project.pipelines.find((candidate) => candidate.id === id);
    if (!pipeline) {
      io.stderr.write(
        `Error: Project ${JSON.stringify(loaded.project.id)} does not define pipeline ${JSON.stringify(id)}.\n`
      );
      return { exitCode: TUBELESS_WORKBENCH_EXIT_CODE.load };
    }
    return {
      cwd: path.dirname(loaded.filePath),
      id,
      kind: "pipeline",
      pipeline,
    };
  }

  const command = loaded.manifest.commands.find((candidate) => candidate.id === id);
  if (!command) {
    io.stderr.write(
      `Error: Command catalog ${loaded.filePath} does not register command ${JSON.stringify(id)}.\n`
    );
    return { exitCode: TUBELESS_WORKBENCH_EXIT_CODE.load };
  }
  return resolveProjectCommandModule(loaded, command);
}

function resolveProjectCommandModule(
  loaded: LoadedCommandCatalog,
  command: CommandCatalogEntry
): ResolvedCommandModule {
  const manifestDirectory = path.dirname(loaded.filePath);
  const resolved: ResolvedPipelineProjectCommand = {
    cwd: path.resolve(manifestDirectory, loaded.manifest.cwd ?? "."),
    filePath: path.resolve(manifestDirectory, command.file),
    id: command.id,
    kind: "module",
  };
  if (command.export !== undefined) resolved.exportName = command.export;
  if (command.name !== undefined) resolved.name = command.name;
  return resolved;
}

async function resolveRegisteredTarget(
  target: string,
  projectFile: string,
  io: WorkbenchCliIo
): Promise<ResolvedPipelineProjectCommand | LoadFailure> {
  const loaded = await loadPipelineProjectFile(projectFile, io);
  if ("exitCode" in loaded) return loaded;
  return resolvePipelineProjectCommand(loaded, target, io);
}

function isPathLike(target: string): boolean {
  return (
    path.isAbsolute(target) ||
    target.startsWith(".") ||
    target.includes("/") ||
    path.extname(target).length > 0
  );
}

async function projectFileForTarget(
  target: string,
  explicitProjectFile: string | undefined,
  io: WorkbenchCliIo
): Promise<string | undefined> {
  if (explicitProjectFile !== undefined) return explicitProjectFile;
  if (isPathLike(target) || (await pathExists(path.resolve(io.cwd, target)))) return undefined;
  const defaultFile = path.resolve(io.cwd, DEFAULT_PIPELINE_PROJECT_FILE);
  return (await pathExists(defaultFile)) ? defaultFile : undefined;
}

async function resolveTargetLoad(
  target: string,
  exportName: string | undefined,
  projectFile: string | undefined,
  io: WorkbenchCliIo,
  usage: string
): Promise<ResolvedTargetLoad | LoadFailure> {
  if (exportName !== undefined && projectFile !== undefined) {
    return { exitCode: writeUsageError(io, EXPORT_PROJECT_MUTEX_ERROR, usage) };
  }

  const resolvedProjectFile = await projectFileForTarget(target, projectFile, io);
  if (resolvedProjectFile === undefined) {
    return { exportName, fileArgument: target, kind: "module", loadIo: io };
  }

  const registration = await resolveRegisteredTarget(target, resolvedProjectFile, io);
  if ("exitCode" in registration) return registration;
  if (registration.kind === "pipeline") {
    return {
      kind: "pipeline",
      loadIo: { ...io, cwd: registration.cwd },
      registration,
    };
  }
  return {
    exportName: registration.exportName,
    fileArgument: registration.filePath,
    kind: "module",
    loadIo: { ...io, cwd: registration.cwd },
    registration,
  };
}

export async function loadPipelineCommandTarget(
  target: string,
  exportName: string | undefined,
  projectFile: string | undefined,
  io: WorkbenchCliIo,
  usage: string
): Promise<
  | {
      command: WorkbenchPipelineCommand;
      commandIo: WorkbenchCliIo;
      exportName: string;
      registration?: ResolvedPipelineProjectCommand;
    }
  | LoadFailure
> {
  const resolved = await resolveTargetLoad(target, exportName, projectFile, io, usage);
  if ("exitCode" in resolved) return resolved;
  if (resolved.kind === "pipeline") {
    const command = inferProjectPipelineCommand(resolved.registration, io);
    if ("exitCode" in command) return command;
    return {
      command,
      commandIo: resolved.loadIo,
      exportName: resolved.registration.id,
      registration: resolved.registration,
    };
  }
  const loaded = await loadPipelineCommand(
    resolved.fileArgument,
    resolved.exportName,
    resolved.loadIo
  );
  if ("exitCode" in loaded) return loaded;
  return { ...loaded, commandIo: resolved.loadIo, registration: resolved.registration };
}

export async function loadPlanSourceTarget(
  target: string,
  exportName: string | undefined,
  projectFile: string | undefined,
  io: WorkbenchCliIo,
  usage: string
): Promise<
  | {
      registration?: ResolvedPipelineProjectCommand;
      view: WorkbenchPipeline;
    }
  | LoadFailure
> {
  const resolved = await resolveTargetLoad(target, exportName, projectFile, io, usage);
  if ("exitCode" in resolved) return resolved;
  if (resolved.kind === "pipeline") {
    return { view: resolved.registration.pipeline, registration: resolved.registration };
  }
  const loaded = await loadPlanSource(resolved.fileArgument, resolved.exportName, resolved.loadIo);
  if ("exitCode" in loaded) return loaded;
  return {
    view: loaded.source.kind === "command" ? loaded.source.command : loaded.source.pipeline,
    registration: resolved.registration,
  };
}

/** Resolve all entries for Studio registration or project inventory. */
export function resolvePipelineProjectCommands(
  loaded: LoadedPipelineProjectFile
): readonly ResolvedPipelineProjectCommand[] {
  if (loaded.kind === "project") {
    const cwd = path.dirname(loaded.filePath);
    return loaded.project.pipelines.map((pipeline) => ({
      cwd,
      id: pipeline.id,
      kind: "pipeline",
      pipeline,
    }));
  }
  return loaded.manifest.commands.map((command) => resolveProjectCommandModule(loaded, command));
}

/** Load or infer the runnable command represented by one project registration. */
export async function loadResolvedPipelineProjectCommand(
  registration: ResolvedPipelineProjectCommand,
  io: WorkbenchCliIo
): Promise<
  { command: WorkbenchPipelineCommand; commandIo: WorkbenchCliIo; exportName: string } | LoadFailure
> {
  const commandIo = { ...io, cwd: registration.cwd };
  if (registration.kind === "pipeline") {
    const command = inferProjectPipelineCommand(registration, io);
    return "exitCode" in command ? command : { command, commandIo, exportName: registration.id };
  }
  const loaded = await loadPipelineCommand(
    registration.filePath,
    registration.exportName,
    commandIo
  );
  if ("exitCode" in loaded) return loaded;
  return { ...loaded, commandIo };
}
