import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { parseArgs, type ParseArgsConfig } from "node:util";
import type { PipelinePlan, PipelineRunControls } from "../core/pipeline.js";
import {
  PIPELINE_MERMAID_DIRECTIONS,
  type PipelineMermaidDirection,
} from "../core/pipeline-types.js";
import { PipelineDocumentError, validatePipelineDocument } from "../project/project-document.js";
import { renderPipelinePlan } from "../render/render.js";
import {
  DEFAULT_PIPELINE_PROJECT_FILE,
  loadPipelineProjectFile,
  resolveWorkbenchRegistration,
} from "./workbench-project-loader.js";
import {
  errorMessage,
  TUBELESS_WORKBENCH_EXIT_CODE,
  writeUsageError,
  type WorkbenchCliIo,
} from "./workbench-shared.js";
import { runWorkbenchSubcommand } from "./workbench-subcommand.js";

const PIPELINE_FILE_POSITIONAL = {
  count: 1,
  message: "Pass exactly one pipeline or command file.",
} as const;

function parseSubcommandArgs<const T extends ParseArgsConfig["options"]>(
  argv: readonly string[],
  options: T
) {
  return parseArgs({
    args: [...argv],
    allowPositionals: true,
    options,
    strict: true,
  });
}

async function loadParsedPlanSource(
  parsed: {
    positionals: readonly string[];
    values: { export?: string; project?: string };
  },
  io: WorkbenchCliIo,
  usage: string
) {
  const registration = await resolveWorkbenchRegistration(
    parsed.positionals[0]!,
    parsed.values.export,
    parsed.values.project,
    io,
    usage
  );
  if ("exitCode" in registration) return registration;
  return registration.loadPlan(io);
}

const LIST_USAGE = `Usage: tubeless list [options]

List pipelines or explicitly registered commands from a Tubeless project file.

Options:
  -p, --project <path>  Project file (default: ./tubeless.project.ts)
      --json            Emit the project inventory as JSON
  -h, --help            Show this help
`;

function parseListArgs(argv: readonly string[]) {
  return parseSubcommandArgs(argv, {
    help: { type: "boolean", short: "h" },
    json: { type: "boolean" },
    project: { type: "string", short: "p" },
  });
}

export async function runList(argv: readonly string[], io: WorkbenchCliIo): Promise<number> {
  return runWorkbenchSubcommand(
    {
      usage: LIST_USAGE,
      parse: parseListArgs,
      positionalCountError: { count: 0, message: "List does not accept a positional argument." },
      async run(parsed, commandIo) {
        const loaded = await loadPipelineProjectFile(
          parsed.values.project ?? DEFAULT_PIPELINE_PROJECT_FILE,
          commandIo
        );
        if ("exitCode" in loaded) return loaded.exitCode;

        if (parsed.values.json) {
          commandIo.stdout.write(`${JSON.stringify(loaded.inventory, null, 2)}\n`);
        } else {
          for (const registration of loaded.registrations) {
            commandIo.stdout.write(`${registration.listing}\n`);
          }
        }
        return TUBELESS_WORKBENCH_EXIT_CODE.success;
      },
    },
    argv,
    io
  );
}

const VALIDATE_USAGE = `Usage: tubeless validate [--json] <document.yaml|document.yml|document.json>

Check pipeline document structure and metadata without importing handlers.
Does not check graph semantics, registered names, or domain values. Use inspect
or plan on the compiled command module for engine validation.
YAML uses Bun's parser; duplicate mapping keys may be overwritten during parsing.

Options:
      --json   Emit a structured validation result
  -h, --help   Show this help
`;

function parseValidateArgs(argv: readonly string[]) {
  return parseSubcommandArgs(argv, {
    help: { type: "boolean", short: "h" },
    json: { type: "boolean" },
  });
}

export async function runValidate(argv: readonly string[], io: WorkbenchCliIo): Promise<number> {
  return runWorkbenchSubcommand(
    {
      usage: VALIDATE_USAGE,
      parse: parseValidateArgs,
      positionalCountError: { count: 1, message: "Pass exactly one YAML or JSON document." },
      async run(parsed, commandIo) {
        const file = resolve(commandIo.cwd, parsed.positionals[0]!);
        try {
          const extension = extname(file).toLowerCase();
          if (![".yaml", ".yml", ".json"].includes(extension)) {
            throw new Error("Expected a .yaml, .yml, or .json document");
          }
          const source = await readFile(file, "utf8");
          let value: unknown;
          if (extension === ".json") value = JSON.parse(source);
          else {
            // The executable runs under Bun; keep its parser out of library entrypoints.
            const specifier = "bun";
            // SAFETY: Bun's documented YAML.parse API returns parsed, untrusted data.
            const { YAML } = (await import(specifier)) as {
              YAML: { parse(text: string): unknown };
            };
            value = YAML.parse(source);
          }
          const document = validatePipelineDocument(value);
          const pipelines = Object.keys(document.pipelines);
          commandIo.stdout.write(
            parsed.values.json
              ? `${JSON.stringify({ ok: true, file, version: document.version, metadata: document.metadata, pipelines })}\n`
              : `Valid pipeline document: ${file} (${pipelines.length} pipeline(s))\n`
          );
          return TUBELESS_WORKBENCH_EXIT_CODE.success;
        } catch (error) {
          if (parsed.values.json) {
            commandIo.stdout.write(
              `${JSON.stringify({
                ok: false,
                file,
                error: {
                  message: errorMessage(error),
                  ...(error instanceof PipelineDocumentError
                    ? { code: error.code, path: error.path }
                    : {}),
                },
              })}\n`
            );
          } else commandIo.stderr.write(`${errorMessage(error)}\n`);
          return TUBELESS_WORKBENCH_EXIT_CODE.validation;
        }
      },
    },
    argv,
    io
  );
}

const INSPECT_USAGE = `Usage: tubeless inspect [options] <pipeline-or-command-file>

Show a registered id or exported pipeline's identity plus the default structural plan.

Options:
  -e, --export <name>   Select a pipeline or command export when the file has more than one
  -p, --project <path>  Resolve a pipeline or command id from this project file
      --json            Emit identity and the default plan as JSON
  -h, --help            Show this help
`;

function formatIdList(values: readonly string[]): string {
  return values.length > 0 ? values.join(", ") : "none";
}

interface WorkbenchInspection {
  commandId?: string;
  pipelineId: string;
  plan: PipelinePlan;
  stepIds: string[];
  targetIds: string[];
}

function parseInspectArgs(argv: readonly string[]) {
  return parseSubcommandArgs(argv, {
    export: { type: "string", short: "e" },
    help: { type: "boolean", short: "h" },
    json: { type: "boolean" },
    project: { type: "string", short: "p" },
  });
}

export async function runInspect(argv: readonly string[], io: WorkbenchCliIo): Promise<number> {
  return runWorkbenchSubcommand(
    {
      usage: INSPECT_USAGE,
      parse: parseInspectArgs,
      positionalCountError: PIPELINE_FILE_POSITIONAL,
      async run(parsed, commandIo) {
        const loaded = await loadParsedPlanSource(parsed, commandIo, INSPECT_USAGE);
        if ("exitCode" in loaded) return loaded.exitCode;

        const { view } = loaded;
        const plan = view.plan();
        if (parsed.values.json) {
          const inspection: WorkbenchInspection = {
            pipelineId: view.id,
            targetIds: [...view.targetIds],
            stepIds: [...view.stepIds],
            plan,
          };
          if (loaded.commandId !== undefined) inspection.commandId = loaded.commandId;
          commandIo.stdout.write(`${JSON.stringify(inspection, null, 2)}\n`);
          return TUBELESS_WORKBENCH_EXIT_CODE.success;
        }

        commandIo.stdout.write(
          [
            ...(loaded.commandId !== undefined ? [`Command ${loaded.commandId}`] : []),
            `Pipeline ${view.id}`,
            `Targets: ${formatIdList(view.targetIds)}`,
            `Exact steps: ${formatIdList(view.stepIds)}`,
            renderPipelinePlan(plan, { explain: false }),
            "",
          ].join("\n")
        );
        return TUBELESS_WORKBENCH_EXIT_CODE.success;
      },
    },
    argv,
    io
  );
}

const PLAN_USAGE = `Usage: tubeless plan [options] <pipeline-or-command-file>

Preview a registered or exported pipeline without running steps or requiring domain options.

Options:
  -e, --export <name>   Select a pipeline or command export when the file has more than one
  -p, --project <path>  Resolve a pipeline or command id from this project file
  -t, --target <id>     Select a declared target and its prerequisites (repeatable)
  -s, --step <id>       Select exact internal steps (repeatable)
      --dry-run         Show each step's dry-run disposition
      --explain         Include target/dependency selection provenance
      --json            Emit the complete structured plan as JSON
  -h, --help            Show this help
`;

function parsePlanArgs(argv: readonly string[]) {
  return parseSubcommandArgs(argv, {
    "dry-run": { type: "boolean" },
    explain: { type: "boolean" },
    export: { type: "string", short: "e" },
    help: { type: "boolean", short: "h" },
    json: { type: "boolean" },
    project: { type: "string", short: "p" },
    step: { type: "string", short: "s", multiple: true },
    target: { type: "string", short: "t", multiple: true },
  });
}

export async function runPlan(argv: readonly string[], io: WorkbenchCliIo): Promise<number> {
  return runWorkbenchSubcommand(
    {
      usage: PLAN_USAGE,
      parse: parsePlanArgs,
      positionalCountError: PIPELINE_FILE_POSITIONAL,
      async run(parsed, commandIo) {
        const loaded = await loadParsedPlanSource(parsed, commandIo, PLAN_USAGE);
        if ("exitCode" in loaded) return loaded.exitCode;

        const controls: PipelineRunControls = {
          dryRun: parsed.values["dry-run"] ?? false,
        };
        if (parsed.values.step !== undefined) controls.stepIds = parsed.values.step;
        if (parsed.values.target !== undefined) controls.targets = parsed.values.target;
        const plan = loaded.view.plan(controls);
        const rendered = parsed.values.json
          ? renderPipelinePlan(plan, { format: "json", pretty: true })
          : renderPipelinePlan(plan, { explain: parsed.values.explain ?? false });
        commandIo.stdout.write(`${rendered}\n`);
        return plan.ok
          ? TUBELESS_WORKBENCH_EXIT_CODE.success
          : TUBELESS_WORKBENCH_EXIT_CODE.planning;
      },
    },
    argv,
    io
  );
}

function isMermaidDirection(value: string): value is PipelineMermaidDirection {
  // SAFETY: PIPELINE_MERMAID_DIRECTIONS is a const tuple of exactly the
  // PipelineMermaidDirection union members, so membership implies a valid direction.
  return (PIPELINE_MERMAID_DIRECTIONS as readonly string[]).includes(value);
}

const GRAPH_USAGE = `Usage: tubeless graph [options] <pipeline-or-command-file>

Generate Mermaid flowchart source from a registered or exported pipeline or command.

Options:
  -e, --export <name>       Select a pipeline or command export when the file has more than one
  -p, --project <path>      Resolve a pipeline or command id from this project file
  -d, --direction <value>   Flowchart direction: BT, LR, RL, TB, or TD (default: TD)
      --descriptions        Include step descriptions in node labels
      --markdown            Wrap the result in a fenced Mermaid Markdown block
  -h, --help                Show this help
`;

function parseGraphArgs(argv: readonly string[]) {
  return parseSubcommandArgs(argv, {
    descriptions: { type: "boolean" },
    direction: { type: "string", short: "d" },
    export: { type: "string", short: "e" },
    help: { type: "boolean", short: "h" },
    markdown: { type: "boolean" },
    project: { type: "string", short: "p" },
  });
}

export async function runGraph(argv: readonly string[], io: WorkbenchCliIo): Promise<number> {
  return runWorkbenchSubcommand(
    {
      usage: GRAPH_USAGE,
      parse: parseGraphArgs,
      positionalCountError: PIPELINE_FILE_POSITIONAL,
      async run(parsed, commandIo) {
        const direction = parsed.values.direction ?? "TD";
        if (!isMermaidDirection(direction)) {
          return writeUsageError(
            commandIo,
            `Invalid direction ${JSON.stringify(direction)}.`,
            GRAPH_USAGE
          );
        }

        const loaded = await loadParsedPlanSource(parsed, commandIo, GRAPH_USAGE);
        if ("exitCode" in loaded) return loaded.exitCode;

        const source = loaded.view.toMermaid({
          direction,
          includeDescriptions: parsed.values.descriptions,
        });
        const terminatedSource = `${source.replace(/\n+$/, "")}\n`;
        commandIo.stdout.write(
          parsed.values.markdown ? `\`\`\`mermaid\n${terminatedSource}\`\`\`\n` : terminatedSource
        );
        return TUBELESS_WORKBENCH_EXIT_CODE.success;
      },
    },
    argv,
    io
  );
}
