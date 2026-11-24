import { WORKBENCH_SPECS } from "./workbench-command-specs.js";
import { renderWorkbenchUsage, runWorkbenchSubcommand } from "./workbench-subcommand.js";
import { lstat, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { cloudflareScaffold } from "./workbench-init-cloudflare.js";
import { projectScaffold } from "./workbench-init-project.js";
import {
  DEFAULT_PIPELINE_PROJECT_FILE,
  loadPipelineProjectFile,
} from "./workbench-project-loader.js";
import { versionAtLeast } from "./workbench-runtime.js";
import {
  errorMessage,
  TUBELESS_WORKBENCH_EXIT_CODE,
  writeUsageError,
  type WorkbenchCliIo,
} from "./workbench-shared.js";

export interface ScaffoldFile {
  readonly path: string;
  readonly contents: string;
}

interface ScaffoldTarget {
  readonly id: string;
  readonly description: string;
  /** Existing paths that block scaffolding although init would not write them, with a fix hint. */
  readonly conflictsWith?: readonly { readonly path: string; readonly hint: string }[];
  /** Node version the target's tooling needs; init warns (does not fail) below it. */
  readonly minimumNode?: { readonly version: string; readonly reason: string };
  readonly nextSteps: readonly string[];
}

/** Starts a new project, so no project file is loaded first. */
export interface ProjectScaffold extends ScaffoldTarget {
  readonly loadsProject: false;
  files(): readonly ScaffoldFile[];
}

/** One deploy target's scaffold. Runtime ports live in its public entrypoint, not here. */
export interface DeployTargetScaffold extends ScaffoldTarget {
  /** The project is loaded, and every command derived, before anything is written. */
  readonly loadsProject: true;
  files(context: {
    readonly cwd: string;
    readonly projectFile: string;
    /** "default" or the named export the project file exposes the project under. */
    readonly projectExport: string;
  }): readonly ScaffoldFile[];
}

const TARGETS = new Map<string, ProjectScaffold | DeployTargetScaffold>([
  [projectScaffold.id, projectScaffold],
  [cloudflareScaffold.id, cloudflareScaffold],
]);

const INIT_USAGE = renderWorkbenchUsage(WORKBENCH_SPECS.init);

/** Anything but a clean "not found" (for example ENOTDIR) counts as occupied, so init never writes through it. */
export async function scaffoldPathOccupied(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

export async function runInit(argv: readonly string[], io: WorkbenchCliIo): Promise<number> {
  return runWorkbenchSubcommand(
    {
      spec: WORKBENCH_SPECS.init,
      async run(parsed, commandIo) {
        const targetId = parsed.positionals[0] ?? WORKBENCH_SPECS.init.defaultSubcommand;
        const target = TARGETS.get(targetId);
        if (!target) {
          return writeUsageError(
            commandIo,
            `Unknown init target ${JSON.stringify(targetId)}. Available: ${[...TARGETS.keys()].join(", ")}.`,
            INIT_USAGE
          );
        }
        if (target.loadsProject) return initDeployment(target, parsed.values.project, commandIo);
        return initProject(commandIo);
      },
    },
    argv,
    io
  );
}

export function initProject(io: WorkbenchCliIo): Promise<number> {
  return writeScaffold(projectScaffold, projectScaffold.files(), io);
}

export async function initDeployment(
  target: DeployTargetScaffold,
  projectFile: string | undefined,
  io: WorkbenchCliIo
): Promise<number> {
  const loaded = await loadPipelineProjectFile(projectFile ?? DEFAULT_PIPELINE_PROJECT_FILE, io);
  if ("exitCode" in loaded) return loaded.exitCode;
  for (const registration of loaded.registrations) {
    const command = await registration.loadCommand(io);
    if ("exitCode" in command) return command.exitCode;
  }
  let files: readonly ScaffoldFile[];
  try {
    files = target.files({
      cwd: io.cwd,
      projectFile: loaded.filePath,
      projectExport: loaded.exportName,
    });
  } catch (error) {
    io.stderr.write(`Error: ${errorMessage(error)}\n`);
    return TUBELESS_WORKBENCH_EXIT_CODE.usage;
  }
  return writeScaffold(target, files, io);
}

async function writeScaffold(
  target: ScaffoldTarget,
  files: readonly ScaffoldFile[],
  io: WorkbenchCliIo
): Promise<number> {
  const conflicts: string[] = [];
  for (const file of files)
    if (await scaffoldPathOccupied(resolve(io.cwd, file.path))) conflicts.push(file.path);
  const related: string[] = [];
  for (const { path, hint } of target.conflictsWith ?? [])
    if (await scaffoldPathOccupied(resolve(io.cwd, path)))
      related.push(`${path} already exists. ${hint}`);
  if (conflicts.length > 0 || related.length > 0) {
    if (conflicts.length > 0)
      io.stderr.write(`Error: Refusing to overwrite existing files: ${conflicts.join(", ")}\n`);
    for (const message of related) io.stderr.write(`Error: ${message}\n`);
    return TUBELESS_WORKBENCH_EXIT_CODE.usage;
  }
  const node = process.versions.bun === undefined ? process.versions.node : undefined;
  if (target.minimumNode && node && !versionAtLeast(node, target.minimumNode.version)) {
    io.stderr.write(
      `Warning: Node ${node} is older than ${target.minimumNode.version}; ${target.minimumNode.reason}.\n`
    );
  }
  const created: string[] = [];
  for (const file of files) {
    const path = resolve(io.cwd, file.path);
    try {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, file.contents, { flag: "wx" });
    } catch (error) {
      io.stderr.write(`Error: Could not write ${file.path}: ${errorMessage(error)}\n`);
      if (created.length > 0) io.stderr.write(`Already created: ${created.join(", ")}\n`);
      return TUBELESS_WORKBENCH_EXIT_CODE.execution;
    }
    created.push(file.path);
    io.stdout.write(`Created ${file.path}\n`);
  }
  if (target.nextSteps.length > 0)
    io.stdout.write(`\nNext steps:\n${target.nextSteps.map((step) => `  ${step}`).join("\n")}\n`);
  return TUBELESS_WORKBENCH_EXIT_CODE.success;
}
