/** Current version of the command catalog contract. */
export const COMMAND_CATALOG_VERSION = 1 as const;

const COMMAND_CATALOG_MARKER = Symbol.for("tubeless/command-catalog/v1");

/** Explicit command-module registration in a command catalog. */
export interface CommandCatalogEntry {
  /** Stable catalog-wide identity used by workbench commands and the studio. */
  id: string;
  /** Command module path, resolved relative to the catalog file. */
  file: string;
  /** Select a named definePipelineCommand export when the module has more than one. */
  export?: string;
  /** Optional display-name override. Defaults to the command's generated name. */
  name?: string;
}

/** Input accepted by `defineCommandCatalog`. */
export interface CommandCatalogInput {
  /** Explicitly registered definePipelineCommand modules. */
  commands: readonly CommandCatalogEntry[];
  /** Command execution directory, relative to this file. Defaults to this file's directory. */
  cwd?: string;
}

/** Validated, immutable command catalog used by the workbench. */
export interface CommandCatalog {
  readonly commands: readonly CommandCatalogEntry[];
  readonly cwd?: string;
  readonly version: typeof COMMAND_CATALOG_VERSION;
}

type MutableCommandCatalog = {
  commands: readonly CommandCatalogEntry[];
  cwd?: string;
  version: typeof COMMAND_CATALOG_VERSION;
};

function requiredText(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
}

/** Declare a versioned, dependency-free catalog of workbench commands. */
export function defineCommandCatalog(catalog: CommandCatalogInput): CommandCatalog {
  if (!Array.isArray(catalog.commands) || catalog.commands.length === 0) {
    throw new Error("Command catalog must declare at least one command.");
  }
  if (catalog.cwd !== undefined) requiredText(catalog.cwd, "Command catalog cwd");

  const ids = new Set<string>();
  const modules = new Set<string>();
  const commands = catalog.commands.map((command, index): CommandCatalogEntry => {
    requiredText(command.id, `Command catalog entry ${index + 1} id`);
    requiredText(command.file, `Command catalog entry ${index + 1} file`);
    if (command.export !== undefined) {
      requiredText(command.export, `Command catalog entry ${index + 1} export`);
    }
    if (command.name !== undefined) {
      requiredText(command.name, `Command catalog entry ${index + 1} name`);
    }
    if (ids.has(command.id)) {
      throw new Error(
        `Command catalog id ${JSON.stringify(command.id)} is declared more than once.`
      );
    }
    ids.add(command.id);
    const moduleIdentity = `${command.file}\0${command.export ?? ""}`;
    if (modules.has(moduleIdentity)) {
      throw new Error(
        `Command catalog module ${JSON.stringify(command.file)}${command.export ? ` export ${JSON.stringify(command.export)}` : ""} is declared more than once.`
      );
    }
    modules.add(moduleIdentity);

    const frozenCommand: CommandCatalogEntry = {
      file: command.file,
      id: command.id,
    };
    if (command.export !== undefined) frozenCommand.export = command.export;
    if (command.name !== undefined) frozenCommand.name = command.name;
    return Object.freeze(frozenCommand);
  });

  const defined: MutableCommandCatalog = {
    commands: Object.freeze(commands),
    version: COMMAND_CATALOG_VERSION,
  };
  if (catalog.cwd !== undefined) defined.cwd = catalog.cwd;
  Object.defineProperty(defined, COMMAND_CATALOG_MARKER, { value: true });
  return Object.freeze(defined);
}

/** Runtime guard used by the workbench when selecting an exported command catalog. */
export function isCommandCatalog(value: unknown): value is CommandCatalog {
  if (typeof value !== "object" || value === null) return false;
  if (!(COMMAND_CATALOG_MARKER in value)) return false;
  // SAFETY: The marker is only installed by defineCommandCatalog, which sets version and
  // commands to their declared types, so reading them via a structural view is safe.
  const candidate = value as { version?: unknown; commands?: unknown };
  return candidate.version === COMMAND_CATALOG_VERSION && Array.isArray(candidate.commands);
}
