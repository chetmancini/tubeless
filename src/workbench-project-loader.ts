import { stat } from "node:fs/promises";
import * as path from "node:path";
import {
  importModuleNamespace,
  selectUniqueExport,
  type WorkbenchPipelineCommand,
  type WorkbenchPlanSource,
} from "./pipeline-module.js";
import {
  isPipelineProjectManifest,
  type PipelineProjectCommandModule,
  type PipelineProjectManifest,
} from "./workbench-project.js";
import {
  errorMessage,
  loadPipelineCommand,
  loadPlanSource,
  TUBELESS_WORKBENCH_EXIT_CODE,
  type WorkbenchCliIo,
} from "./workbench-shared.js";

/** Default project manifest checked in the invocation directory. No parent search is performed. */
export const DEFAULT_PIPELINE_PROJECT_MANIFEST = "tubeless.project.ts";

export interface LoadedPipelineProjectManifest {
  filePath: string;
  manifest: PipelineProjectManifest;
}

export interface ResolvedPipelineProjectCommand {
  cwd: string;
  exportName?: string;
  filePath: string;
  id: string;
  name?: string;
}

type LoadFailure = { exitCode: number };

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

/** Load one explicitly named project manifest without searching parent directories. */
export async function loadPipelineProjectManifest(
  fileArgument: string,
  io: WorkbenchCliIo
): Promise<LoadedPipelineProjectManifest | LoadFailure> {
  const filePath = path.resolve(io.cwd, fileArgument);
  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) throw new Error(`${filePath} is not a file.`);
    const manifest = selectUniqueExport(
      await importModuleNamespace(filePath),
      undefined,
      isPipelineProjectManifest,
      "project manifest",
      { hintExport: false }
    );
    const moduleIdentities = new Set<string>();
    for (const command of manifest.commands) {
      const moduleIdentity = `${path.resolve(path.dirname(filePath), command.file)}\0${command.export ?? ""}`;
      if (moduleIdentities.has(moduleIdentity)) {
        throw new Error(
          `Project manifest command ${JSON.stringify(command.file)}${command.export ? ` export ${JSON.stringify(command.export)}` : ""} resolves to a duplicate module registration.`
        );
      }
      moduleIdentities.add(moduleIdentity);
    }
    return { filePath, manifest };
  } catch (error) {
    io.stderr.write(`Error: ${errorMessage(error)}\n`);
    return { exitCode: TUBELESS_WORKBENCH_EXIT_CODE.load };
  }
}

/** Resolve one stable command id from a loaded manifest. */
export function resolvePipelineProjectCommand(
  loaded: LoadedPipelineProjectManifest,
  id: string,
  io: WorkbenchCliIo
): ResolvedPipelineProjectCommand | LoadFailure {
  const command = loaded.manifest.commands.find((candidate) => candidate.id === id);
  if (!command) {
    io.stderr.write(
      `Error: Project manifest ${loaded.filePath} does not register command ${JSON.stringify(id)}.\n`
    );
    return { exitCode: TUBELESS_WORKBENCH_EXIT_CODE.load };
  }
  return resolveProjectCommandModule(loaded, command);
}

function resolveProjectCommandModule(
  loaded: LoadedPipelineProjectManifest,
  command: PipelineProjectCommandModule
): ResolvedPipelineProjectCommand {
  const manifestDirectory = path.dirname(loaded.filePath);
  const resolved: ResolvedPipelineProjectCommand = {
    cwd: path.resolve(manifestDirectory, loaded.manifest.cwd ?? "."),
    filePath: path.resolve(manifestDirectory, command.file),
    id: command.id,
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
  const loaded = await loadPipelineProjectManifest(projectFile, io);
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
  const defaultFile = path.resolve(io.cwd, DEFAULT_PIPELINE_PROJECT_MANIFEST);
  return (await pathExists(defaultFile)) ? defaultFile : undefined;
}

export async function loadPipelineCommandTarget(
  target: string,
  exportName: string | undefined,
  projectFile: string | undefined,
  io: WorkbenchCliIo
): Promise<
  | {
      command: WorkbenchPipelineCommand;
      commandIo: WorkbenchCliIo;
      exportName: string;
      registration?: ResolvedPipelineProjectCommand;
    }
  | LoadFailure
> {
  const resolvedProjectFile = await projectFileForTarget(target, projectFile, io);
  if (resolvedProjectFile === undefined) {
    const loaded = await loadPipelineCommand(target, exportName, io);
    if ("exitCode" in loaded) return loaded;
    return { ...loaded, commandIo: io };
  }

  const registration = await resolveRegisteredTarget(target, resolvedProjectFile, io);
  if ("exitCode" in registration) return registration;
  const commandIo = { ...io, cwd: registration.cwd };
  const loaded = await loadPipelineCommand(
    registration.filePath,
    registration.exportName,
    commandIo
  );
  if ("exitCode" in loaded) return loaded;
  return { ...loaded, commandIo, registration };
}

export async function loadPlanSourceTarget(
  target: string,
  exportName: string | undefined,
  projectFile: string | undefined,
  io: WorkbenchCliIo
): Promise<
  | {
      source: WorkbenchPlanSource;
      registration?: ResolvedPipelineProjectCommand;
    }
  | LoadFailure
> {
  const resolvedProjectFile = await projectFileForTarget(target, projectFile, io);
  if (resolvedProjectFile === undefined) return loadPlanSource(target, exportName, io);

  const registration = await resolveRegisteredTarget(target, resolvedProjectFile, io);
  if ("exitCode" in registration) return registration;
  const commandIo = { ...io, cwd: registration.cwd };
  const loaded = await loadPlanSource(registration.filePath, registration.exportName, commandIo);
  if ("exitCode" in loaded) return loaded;
  return { ...loaded, registration };
}
