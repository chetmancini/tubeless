/** Portable, deliberately restricted Node 24 / Bun 1.4.4 check recipe. */
export interface NodeCheckConfig {
  version: 1;
  toolchain: { node: "24"; bun: "1.4.4" };
  maxConcurrency?: number;
  checks: (CheckOptions &
    ({ script: string; vitest?: never } | { script?: never; vitest: { report: string } }))[];
}
interface CheckOptions {
  id: string;
  dependsOn?: string[];
  timeoutMs?: number;
}
interface CommandOptions extends Required<CheckOptions> {
  argv: string[];
  reason: string;
}
/** One resolved native command, with metadata appropriate to its execution kind. */
export type NodeCheckCommand = CommandOptions &
  (
    | { kind: "install" }
    | { kind: "script"; script: { name: string; body: string } }
    | { kind: "vitest"; report: { adapter: "vitest"; version: "5.1.0"; path: string } }
  );
/** All commands, dependency edges and script bodies are part of admission identity. */
export interface NodeCheckPlan {
  version: 1;
  recipe: "node-check-v1";
  toolchain: { node: "24"; bun: "1.4.4" };
  lockfile: "bun.lock";
  maxConcurrency: number;
  commands: NodeCheckCommand[];
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TypeError(`Invalid ${label}.`);
  return value as Record<string, unknown>;
}
function object(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  const result = record(value, label);
  if (Object.keys(result).some((key) => !keys.includes(key)))
    throw new TypeError(`Unsupported ${label} configuration.`);
  return result;
}
function integer(value: unknown, max: number, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > max)
    throw new TypeError(`${label} must be an integer from 1 to ${max}.`);
  return value;
}
function toolchain(value: unknown): NodeCheckPlan["toolchain"] {
  const tools = object(value, ["node", "bun"], "toolchain");
  if (tools.node !== "24" || tools.bun !== "1.4.4")
    throw new TypeError("Supported toolchain: Node 24, Bun 1.4.4.");
  return { node: "24", bun: "1.4.4" };
}
const CHECK_ID = /^[a-z][a-z0-9-]{0,47}$/;

function prerequisites(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length > 16 ||
    !value.every((id): id is string => typeof id === "string" && CHECK_ID.test(id)) ||
    new Set(value).size !== value.length
  )
    throw new TypeError("Check dependencies must be unique IDs.");
  return [...value];
}
function checkOptions(raw: Record<string, unknown>): Required<CheckOptions> {
  if (typeof raw.id !== "string" || !CHECK_ID.test(raw.id) || raw.id === "install")
    throw new TypeError("Checks require simple IDs; install is reserved.");
  return {
    id: raw.id,
    dependsOn: prerequisites(raw.dependsOn === undefined ? [] : raw.dependsOn),
    timeoutMs: integer(
      raw.timeoutMs === undefined ? 60_000 : raw.timeoutMs,
      300_000,
      "Check timeout"
    ),
  };
}
function script(value: unknown, body: unknown): { name: string; body: string } {
  if (
    typeof value !== "string" ||
    value.startsWith("-") ||
    !/^[a-zA-Z0-9:_-]{1,80}$/.test(value) ||
    typeof body !== "string" ||
    !body.trim() ||
    body.length > 4096
  )
    throw new TypeError("Missing or invalid package script.");
  return { name: value, body };
}
/** Report files are confined to one dedicated directory; no absolute or traversing paths. */
export function isNodeCheckReportPath(value: unknown): value is string {
  return typeof value === "string" && /^\.tubeless-reports\/[a-zA-Z0-9_-]{1,80}\.json$/.test(value);
}
function installCommand(): NodeCheckCommand {
  return {
    kind: "install",
    id: "install",
    argv: ["bun", "install", "--frozen-lockfile"],
    dependsOn: [],
    timeoutMs: 300_000,
    reason: "Install the committed bun.lock without updating it.",
  };
}
function scriptCommand(
  options: Required<CheckOptions>,
  metadata: { name: string; body: string }
): NodeCheckCommand {
  return {
    ...options,
    kind: "script",
    argv: ["bun", "run", "--silent", metadata.name],
    script: metadata,
    reason: "Explicitly configured repository gate.",
  };
}
function vitestCommand(options: Required<CheckOptions>, path: unknown): NodeCheckCommand {
  if (!isNodeCheckReportPath(path))
    throw new TypeError("Use a .tubeless-reports/<name>.json path.");
  return {
    ...options,
    kind: "vitest",
    argv: [
      "node",
      "node_modules/vitest/vitest.mjs",
      "run",
      "--reporter=json",
      `--outputFile=${path}`,
      "--includeTaskLocation",
    ],
    report: { adapter: "vitest", version: "5.1.0", path },
    reason: "Explicitly configured repository gate.",
  };
}

function orderedCommands(commands: NodeCheckCommand[]): NodeCheckCommand[] {
  const byId = new Map(commands.map((command) => [command.id, command]));
  if (byId.size !== commands.length) throw new TypeError("Checks require unique IDs.");
  const reports = commands
    .filter((command) => command.kind === "vitest")
    .map((command) => command.report.path.toLowerCase());
  if (reports.length > 2 || new Set(reports).size !== reports.length)
    throw new TypeError("At most two unique Vitest reports are supported.");
  // This orders step construction only; Tubeless remains the execution scheduler.
  const ordered: NodeCheckCommand[] = [],
    visiting = new Set<string>(),
    visited = new Set<string>();
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    const command = byId.get(id);
    if (!command || visiting.has(id))
      throw new TypeError(`Unknown or cyclic check dependency: ${id}.`);
    visiting.add(id);
    for (const dep of command.dependsOn) visit(dep);
    visiting.delete(id);
    visited.add(id);
    ordered.push(command);
  };
  for (const command of commands) visit(command.id);
  return ordered;
}
function plan(
  tools: NodeCheckPlan["toolchain"],
  concurrency: unknown,
  commands: NodeCheckCommand[]
): NodeCheckPlan {
  if (commands.length < 2 || commands.length > 17)
    throw new TypeError("Configure between 1 and 16 checks.");
  const result: NodeCheckPlan = {
    version: 1,
    recipe: "node-check-v1",
    toolchain: tools,
    lockfile: "bun.lock",
    maxConcurrency: integer(concurrency, 4, "maxConcurrency"),
    commands: orderedCommands(commands),
  };
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 32_768)
    throw new TypeError("Resolved check plan exceeds 32 KiB.");
  return result;
}

/** Resolve data only. Does not execute scripts, access credentials or infer absent checks. */
export function resolveNodeCheckPlan(configuration: unknown, packageJson: unknown): NodeCheckPlan {
  const config = object(
    configuration,
    ["version", "toolchain", "maxConcurrency", "checks"],
    "recipe"
  );
  if (config.version !== 1) throw new TypeError("Supported recipe version: 1.");
  const tools = toolchain(config.toolchain),
    manifest = record(packageJson, "package.json");
  if (manifest.packageManager !== "bun@1.4.4" || manifest.workspaces !== undefined)
    throw new TypeError("Use packageManager bun@1.4.4 in a single-package repository.");
  if (!Array.isArray(config.checks) || config.checks.length < 1 || config.checks.length > 16)
    throw new TypeError("Configure between 1 and 16 checks.");
  const commands = [installCommand()];
  for (const raw of config.checks) {
    const check = object(raw, ["id", "script", "vitest", "dependsOn", "timeoutMs"], "check");
    const options = checkOptions(check);
    if (options.dependsOn.includes("install"))
      throw new TypeError("Install is an implicit prerequisite.");
    options.dependsOn = ["install", ...options.dependsOn];
    if ((check.script === undefined) === (check.vitest === undefined))
      throw new TypeError(`Choose exactly one script or vitest check for ${options.id}.`);
    if (check.script !== undefined) {
      const scripts = record(manifest.scripts, "package scripts");
      commands.push(
        scriptCommand(
          options,
          script(
            check.script,
            typeof check.script === "string" && Object.hasOwn(scripts, check.script)
              ? scripts[check.script]
              : undefined
          )
        )
      );
    } else {
      const report = object(check.vitest, ["report"], "Vitest");
      if (record(manifest.devDependencies, "devDependencies").vitest !== "5.1.0")
        throw new TypeError("Vitest requires devDependency 5.1.0.");
      commands.push(vitestCommand(options, report.report));
    }
  }
  return plan(tools, config.maxConcurrency === undefined ? 1 : config.maxConcurrency, commands);
}

function matchesCommandWords(value: unknown, expected: readonly string[]): boolean {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    expected.every((word, index) => value[index] === word)
  );
}

function decodeCommand(value: unknown): NodeCheckCommand {
  const header = record(value, "command");
  const keys = ["kind", "id", "argv", "dependsOn", "timeoutMs", "reason"];
  const raw = object(
    value,
    [
      ...keys,
      ...(header.kind === "script" ? ["script"] : header.kind === "vitest" ? ["report"] : []),
    ],
    "command"
  );
  let command: NodeCheckCommand;
  if (raw.kind === "install") command = installCommand();
  else {
    const options = checkOptions(raw);
    if (options.dependsOn[0] !== "install")
      throw new TypeError("Missing installation prerequisite.");
    if (raw.kind === "script") {
      const metadata = object(raw.script, ["name", "body"], "script");
      command = scriptCommand(options, script(metadata.name, metadata.body));
    } else if (raw.kind === "vitest") {
      const report = object(raw.report, ["adapter", "version", "path"], "report");
      if (report.adapter !== "vitest" || report.version !== "5.1.0")
        throw new TypeError("Unsupported report adapter.");
      command = vitestCommand(options, report.path);
    } else throw new TypeError("Unsupported check kind.");
  }
  if (
    raw.id !== command.id ||
    raw.timeoutMs !== command.timeoutMs ||
    raw.reason !== command.reason ||
    !matchesCommandWords(raw.dependsOn, command.dependsOn) ||
    !matchesCommandWords(raw.argv, command.argv)
  )
    throw new TypeError("Command differs from the supported execution plan.");
  return command;
}
/** Decode the bounded command contract directly; arbitrary argv and execution kinds are rejected. */
export function decodeNodeCheckPlan(value: unknown): NodeCheckPlan | undefined {
  try {
    const raw = object(
      value,
      ["version", "recipe", "toolchain", "lockfile", "maxConcurrency", "commands"],
      "plan"
    );
    if (
      raw.version !== 1 ||
      raw.recipe !== "node-check-v1" ||
      raw.lockfile !== "bun.lock" ||
      !Array.isArray(raw.commands) ||
      raw.commands.length > 17 ||
      raw.commands[0]?.kind !== "install"
    )
      return undefined;
    const commands = raw.commands.map(decodeCommand);
    const result = plan(toolchain(raw.toolchain), raw.maxConcurrency, commands);
    return result.commands.every((command, index) => command === commands[index])
      ? result
      : undefined;
  } catch {
    return undefined;
  }
}
