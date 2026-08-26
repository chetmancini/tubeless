/** Current version of the declarative local-studio configuration contract. */
export const PIPELINE_STUDIO_CONFIG_VERSION = 1 as const;

const PIPELINE_STUDIO_CONFIG_MARKER = Symbol.for("tubeless/pipeline-studio-config/v1");

export interface PipelineStudioCommandModule {
  /** Command module path, resolved relative to the studio configuration file. */
  file: string;
  /** Select a named definePipelineCommand export when the module has more than one. */
  export?: string;
  /** Optional display-name override. Defaults to the command's generated name. */
  name?: string;
}

export interface PipelineStudioConfigInput {
  /** Explicitly registered definePipelineCommand modules. */
  commands: readonly PipelineStudioCommandModule[];
  /** Command execution directory, relative to this file. Defaults to this file's directory. */
  cwd?: string;
}

export interface PipelineStudioConfig {
  readonly commands: readonly PipelineStudioCommandModule[];
  readonly cwd?: string;
  readonly version: typeof PIPELINE_STUDIO_CONFIG_VERSION;
}

/** Mutable build-time view of a studio config; frozen before it is returned. */
type MutableStudioConfig = {
  commands: readonly PipelineStudioCommandModule[];
  cwd?: string;
  version: typeof PIPELINE_STUDIO_CONFIG_VERSION;
};

function requiredText(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
}

/** Declare a versioned, dependency-free manifest of commands available to `tubeless ui`. */
export function definePipelineStudio(config: PipelineStudioConfigInput): PipelineStudioConfig {
  if (!Array.isArray(config.commands) || config.commands.length === 0) {
    throw new Error("Pipeline studio config must declare at least one command.");
  }
  if (config.cwd !== undefined) requiredText(config.cwd, "Pipeline studio cwd");

  const identities = new Set<string>();
  const commands = config.commands.map((command, index): PipelineStudioCommandModule => {
    requiredText(command.file, `Pipeline studio command ${index + 1} file`);
    if (command.export !== undefined) {
      requiredText(command.export, `Pipeline studio command ${index + 1} export`);
    }
    if (command.name !== undefined) {
      requiredText(command.name, `Pipeline studio command ${index + 1} name`);
    }
    const identity = `${command.file}\0${command.export ?? ""}`;
    if (identities.has(identity)) {
      throw new Error(
        `Pipeline studio command ${JSON.stringify(command.file)}${command.export ? ` export ${JSON.stringify(command.export)}` : ""} is declared more than once.`
      );
    }
    identities.add(identity);
    const frozenCommand: PipelineStudioCommandModule = { file: command.file };
    if (command.export !== undefined) frozenCommand.export = command.export;
    if (command.name !== undefined) frozenCommand.name = command.name;
    return Object.freeze(frozenCommand);
  });

  const defined: MutableStudioConfig = {
    commands: Object.freeze(commands),
    version: PIPELINE_STUDIO_CONFIG_VERSION,
  };
  if (config.cwd !== undefined) defined.cwd = config.cwd;
  Object.defineProperty(defined, PIPELINE_STUDIO_CONFIG_MARKER, { value: true });
  return Object.freeze(defined);
}

/** Runtime guard used by the workbench when selecting an exported studio config. */
export function isPipelineStudioConfig(value: unknown): value is PipelineStudioConfig {
  if (typeof value !== "object" || value === null) return false;
  if (!(PIPELINE_STUDIO_CONFIG_MARKER in value)) return false;
  // SAFETY: The marker is only installed by definePipelineStudio, which sets version and
  // commands to their declared types, so reading them via a structural view is safe.
  const candidate = value as { version?: unknown; commands?: unknown };
  return candidate.version === PIPELINE_STUDIO_CONFIG_VERSION && Array.isArray(candidate.commands);
}
