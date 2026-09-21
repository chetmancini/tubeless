import { stat } from "node:fs/promises";
import * as path from "node:path";
import {
  importModuleNamespace,
  selectUniqueExport,
  type WorkbenchPipeline,
  type WorkbenchPipelineCommand,
} from "./pipeline-module.js";
import { definePipelineCommand } from "../cli/cli-pipeline-command.js";
import { isCommandCatalog, type CommandCatalogEntry } from "../cli/command-catalog.js";
import { isPipelineProject, type AnyProjectPipeline } from "../project/pipeline-project.js";
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

type LoadFailure = { exitCode: number };

/** A source normalized once for discovery, planning, execution, and Studio. */
export interface WorkbenchRegistration {
  readonly identity: string;
  readonly source: string;
  readonly cwd: string;
  /** Stable project/catalog id; direct modules acquire their Studio id after loading. */
  readonly id?: string;
  readonly name?: string;
  readonly listing: string;
  loadPlan(
    io: WorkbenchCliIo
  ): Promise<{ view: WorkbenchPipeline; commandId?: string } | LoadFailure>;
  loadCommand(
    io: WorkbenchCliIo
  ): Promise<
    | { command: WorkbenchPipelineCommand; commandIo: WorkbenchCliIo; exportName: string }
    | LoadFailure
  >;
}

interface WorkbenchProjectFile {
  filePath: string;
  registrations: readonly WorkbenchRegistration[];
  inventory: Record<string, unknown>;
}

/** Keep module imports lazy, including direct files and catalog entries. */
export function createModuleRegistration(
  filePath: string,
  cwd: string,
  exportName?: string,
  entry?: CommandCatalogEntry
): WorkbenchRegistration {
  filePath = path.resolve(cwd, filePath);
  return {
    identity: `${filePath}\0${exportName ?? ""}`,
    source: filePath,
    cwd,
    id: entry?.id,
    name: entry?.name,
    listing: entry
      ? `${entry.id}\t${entry.file}${exportName ? `#${exportName}` : ""}${entry.name ? `\t${entry.name}` : ""}`
      : filePath,
    async loadPlan(io) {
      const loaded = await loadPlanSource(filePath, exportName, { ...io, cwd });
      if ("exitCode" in loaded) return loaded;
      return {
        view: loaded.source.kind === "command" ? loaded.source.command : loaded.source.pipeline,
        commandId: entry?.id,
      };
    },
    async loadCommand(io) {
      const commandIo = { ...io, cwd };
      const loaded = await loadPipelineCommand(filePath, exportName, commandIo);
      return "exitCode" in loaded ? loaded : { ...loaded, commandIo };
    },
  };
}

function createPipelineRegistration(
  pipeline: AnyProjectPipeline,
  filePath: string
): WorkbenchRegistration {
  const cwd = path.dirname(filePath);
  return {
    identity: `project-pipeline\0${filePath}\0${pipeline.id}`,
    source: pipeline.id,
    cwd,
    id: pipeline.id,
    listing: pipeline.id,
    async loadPlan() {
      return { view: pipeline };
    },
    async loadCommand(io) {
      try {
        // Project registration erases option types, so absence of a schema cannot
        // establish that the pipeline has no required domain inputs.
        if (pipeline.optionsSchema === undefined) {
          throw new Error(
            "Automatic project commands require Standard JSON Schema input metadata. " +
              "Use createSteps(schema), or register a definePipelineCommand with explicit params through defineCommandCatalog."
          );
        }
        return {
          command: definePipelineCommand(pipeline),
          commandIo: { ...io, cwd },
          exportName: pipeline.id,
        };
      } catch (error) {
        io.stderr.write(
          `Error: Cannot derive a CLI for project pipeline ${JSON.stringify(pipeline.id)}: ${errorMessage(error)}\n`
        );
        return { exitCode: TUBELESS_WORKBENCH_EXIT_CODE.load };
      }
    },
  };
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

/** Select one root and normalize it without importing catalog command modules. */
export async function loadPipelineProjectFile(
  fileArgument: string,
  io: WorkbenchCliIo
): Promise<WorkbenchProjectFile | LoadFailure> {
  const filePath = path.resolve(io.cwd, fileArgument);
  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) throw new Error(`${filePath} is not a file.`);
    const moduleExports = await importModuleNamespace(filePath);
    const root = selectUniqueExport(
      moduleExports,
      Object.hasOwn(moduleExports, "default") ? "default" : undefined,
      (value) => isPipelineProject(value) || isCommandCatalog(value),
      "project or command catalog",
      { hintExport: false }
    ).value;
    if (isPipelineProject(root)) {
      return {
        filePath,
        registrations: root.pipelines.map((pipeline) =>
          createPipelineRegistration(pipeline, filePath)
        ),
        inventory: {
          id: root.id,
          name: root.name,
          description: root.description,
          pipelines: root.pipelineIds,
          project: filePath,
        },
      };
    }

    const directory = path.dirname(filePath);
    const cwd = path.resolve(directory, root.cwd ?? ".");
    const registrations = root.commands.map((entry) =>
      createModuleRegistration(path.resolve(directory, entry.file), cwd, entry.export, entry)
    );
    const identities = new Set<string>();
    for (const registration of registrations) {
      if (identities.has(registration.identity)) {
        throw new Error(
          `Command catalog entry ${JSON.stringify(registration.source)} resolves to a duplicate module registration.`
        );
      }
      identities.add(registration.identity);
    }
    return {
      filePath,
      registrations,
      inventory: {
        commands: root.commands,
        cwd: root.cwd ?? ".",
        manifest: filePath,
        version: root.version,
      },
    };
  } catch (error) {
    io.stderr.write(`Error: ${errorMessage(error)}\n`);
    return { exitCode: TUBELESS_WORKBENCH_EXIT_CODE.load };
  }
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

/** Resolve a direct file or registered id to the same lazy loading contract. */
export async function resolveWorkbenchRegistration(
  target: string,
  exportName: string | undefined,
  projectFile: string | undefined,
  io: WorkbenchCliIo,
  usage: string
): Promise<WorkbenchRegistration | LoadFailure> {
  if (exportName !== undefined && projectFile !== undefined) {
    return {
      exitCode: writeUsageError(
        io,
        "--export cannot be combined with --project; the project file owns export selection.",
        usage
      ),
    };
  }

  const resolvedProjectFile = await projectFileForTarget(target, projectFile, io);
  if (resolvedProjectFile === undefined) {
    return createModuleRegistration(target, io.cwd, exportName);
  }
  const loaded = await loadPipelineProjectFile(resolvedProjectFile, io);
  if ("exitCode" in loaded) return loaded;
  const registration = loaded.registrations.find(({ id }) => id === target);
  if (registration) return registration;
  io.stderr.write(
    `Error: Project file ${loaded.filePath} does not register pipeline or command ${JSON.stringify(target)}.\n`
  );
  return { exitCode: TUBELESS_WORKBENCH_EXIT_CODE.load };
}
