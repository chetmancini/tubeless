/** Current version of the declarative Tubeless project manifest contract. */
export const PIPELINE_PROJECT_MANIFEST_VERSION = 1 as const;

const PIPELINE_PROJECT_MANIFEST_MARKER = Symbol.for("tubeless/pipeline-project-manifest/v1");

export interface PipelineProjectCommandModule {
  /** Stable project-wide identity used by workbench commands and the studio. */
  id: string;
  /** Command module path, resolved relative to the project manifest file. */
  file: string;
  /** Select a named definePipelineCommand export when the module has more than one. */
  export?: string;
  /** Optional display-name override. Defaults to the command's generated name. */
  name?: string;
}

export interface PipelineProjectManifestInput {
  /** Explicitly registered definePipelineCommand modules. */
  commands: readonly PipelineProjectCommandModule[];
  /** Command execution directory, relative to this file. Defaults to this file's directory. */
  cwd?: string;
}

export interface PipelineProjectManifest {
  readonly commands: readonly PipelineProjectCommandModule[];
  readonly cwd?: string;
  readonly version: typeof PIPELINE_PROJECT_MANIFEST_VERSION;
}

type MutableProjectManifest = {
  commands: readonly PipelineProjectCommandModule[];
  cwd?: string;
  version: typeof PIPELINE_PROJECT_MANIFEST_VERSION;
};

function requiredText(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
}

/** Declare a versioned, dependency-free project manifest of workbench commands. */
export function definePipelineProject(
  manifest: PipelineProjectManifestInput
): PipelineProjectManifest {
  if (!Array.isArray(manifest.commands) || manifest.commands.length === 0) {
    throw new Error("Pipeline project manifest must declare at least one command.");
  }
  if (manifest.cwd !== undefined) requiredText(manifest.cwd, "Pipeline project cwd");

  const ids = new Set<string>();
  const modules = new Set<string>();
  const commands = manifest.commands.map((command, index): PipelineProjectCommandModule => {
    requiredText(command.id, `Pipeline project command ${index + 1} id`);
    requiredText(command.file, `Pipeline project command ${index + 1} file`);
    if (command.export !== undefined) {
      requiredText(command.export, `Pipeline project command ${index + 1} export`);
    }
    if (command.name !== undefined) {
      requiredText(command.name, `Pipeline project command ${index + 1} name`);
    }
    if (ids.has(command.id)) {
      throw new Error(
        `Pipeline project command id ${JSON.stringify(command.id)} is declared more than once.`
      );
    }
    ids.add(command.id);
    const moduleIdentity = `${command.file}\0${command.export ?? ""}`;
    if (modules.has(moduleIdentity)) {
      throw new Error(
        `Pipeline project command ${JSON.stringify(command.file)}${command.export ? ` export ${JSON.stringify(command.export)}` : ""} is declared more than once.`
      );
    }
    modules.add(moduleIdentity);

    const frozenCommand: PipelineProjectCommandModule = {
      file: command.file,
      id: command.id,
    };
    if (command.export !== undefined) frozenCommand.export = command.export;
    if (command.name !== undefined) frozenCommand.name = command.name;
    return Object.freeze(frozenCommand);
  });

  const defined: MutableProjectManifest = {
    commands: Object.freeze(commands),
    version: PIPELINE_PROJECT_MANIFEST_VERSION,
  };
  if (manifest.cwd !== undefined) defined.cwd = manifest.cwd;
  Object.defineProperty(defined, PIPELINE_PROJECT_MANIFEST_MARKER, { value: true });
  return Object.freeze(defined);
}

/** Runtime guard used by the workbench when selecting an exported project manifest. */
export function isPipelineProjectManifest(value: unknown): value is PipelineProjectManifest {
  if (typeof value !== "object" || value === null) return false;
  if (!(PIPELINE_PROJECT_MANIFEST_MARKER in value)) return false;
  // SAFETY: The marker is only installed by definePipelineProject, which sets version and
  // commands to their declared types, so reading them via a structural view is safe.
  const candidate = value as { version?: unknown; commands?: unknown };
  return (
    candidate.version === PIPELINE_PROJECT_MANIFEST_VERSION && Array.isArray(candidate.commands)
  );
}
