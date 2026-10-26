import { WORKBENCH_SPECS } from "./workbench-command-specs.js";
import {
  renderWorkbenchUsage,
  parseSubcommandArgs,
  runWorkbenchSubcommand,
} from "./workbench-subcommand.js";
import { querySteps } from "../core/pipeline.js";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import type { PipelinePlan, PipelineRunControls } from "../core/pipeline.js";
import {
  PIPELINE_MERMAID_DIRECTIONS,
  type PipelineMermaidDirection,
} from "../core/pipeline-types.js";
import { PipelineDocumentError, validatePipelineDocument } from "../project/project-document.js";
import { renderPipelinePlan } from "../render/render.js";
import { isWorkbenchPipelineCommand, type WorkbenchPipeline } from "./pipeline-module.js";
import {
  DEFAULT_PIPELINE_PROJECT_FILE,
  loadPipelineProjectFile,
  resolveWorkbenchRegistration,
} from "./workbench-project-loader.js";
import {
  errorMessage,
  terminalSafeText,
  TUBELESS_WORKBENCH_EXIT_CODE,
  writeUsageError,
  type WorkbenchCliIo,
} from "./workbench-shared.js";

const PIPELINE_FILE_POSITIONAL = {
  count: 1,
  message: "Pass exactly one pipeline or command file.",
} as const;

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

/** One terminal-safe line: control characters removed and whitespace collapsed. */
function inlineText(value: string): string {
  return terminalSafeText(value).replace(/\s+/g, " ").trim();
}

function optionalInlineText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = inlineText(value);
  return text === "" ? undefined : text;
}

/** Display name (only when it differs from the id) and description of a pipeline or command. */
function pipelineIdentityText(view: WorkbenchPipeline): { name?: string; description?: string } {
  const source = isWorkbenchPipelineCommand(view) ? view.descriptor : view;
  const name = "name" in source ? optionalInlineText(source.name) : undefined;
  const description = "description" in source ? optionalInlineText(source.description) : undefined;
  return {
    ...(name !== undefined && name !== inlineText(view.id) ? { name } : {}),
    ...(description !== undefined ? { description } : {}),
  };
}

/** `Name - description`, either part alone, or undefined when neither is present. */
function joinNameAndDescription(name?: string, description?: string): string | undefined {
  if (name !== undefined && description !== undefined) return `${name} - ${description}`;
  return name ?? description;
}

/** Rows of `<key>  <summary>` with summaries aligned and no trailing spaces. */
function alignedRows(
  rows: readonly { key: string; summary: string | undefined }[],
  indent = ""
): string[] {
  const width = rows.reduce((width, { key }) => Math.max(width, key.length), 0);
  return rows.map(({ key, summary }) =>
    summary === undefined ? `${indent}${key}` : `${indent}${key.padEnd(width)}  ${summary}`
  );
}

function parseListArgs(argv: readonly string[]) {
  return parseSubcommandArgs(argv, WORKBENCH_SPECS.list.options);
}

export async function runList(argv: readonly string[], io: WorkbenchCliIo): Promise<number> {
  return runWorkbenchSubcommand(
    {
      spec: WORKBENCH_SPECS.list,
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
          return TUBELESS_WORKBENCH_EXIT_CODE.success;
        }

        const rows: { key: string; summary: string | undefined }[] = [];
        for (const registration of loaded.registrations) {
          const plan = await registration.loadPlan(commandIo);
          if ("exitCode" in plan) return plan.exitCode;
          const { name, description } = pipelineIdentityText(plan.view);
          rows.push({
            key: inlineText(plan.view.id),
            summary: joinNameAndDescription(name, description),
          });
        }
        if (rows.length > 0) commandIo.stdout.write(`${alignedRows(rows).join("\n")}\n`);
        return TUBELESS_WORKBENCH_EXIT_CODE.success;
      },
    },
    argv,
    io
  );
}

function parseValidateArgs(argv: readonly string[]) {
  return parseSubcommandArgs(argv, WORKBENCH_SPECS.validate.options);
}

export async function runValidate(argv: readonly string[], io: WorkbenchCliIo): Promise<number> {
  return runWorkbenchSubcommand(
    {
      spec: WORKBENCH_SPECS.validate,
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

const INSPECT_USAGE = renderWorkbenchUsage(WORKBENCH_SPECS.inspect);

function formatIdList(values: readonly string[]): string {
  return values.length > 0 ? values.join(", ") : "none";
}

interface WorkbenchInspection {
  pipelineId: string;
  plan: PipelinePlan;
  stepIds: string[];
  targetIds: string[];
}

function parseInspectArgs(argv: readonly string[]) {
  return parseSubcommandArgs(argv, WORKBENCH_SPECS.inspect.options);
}

export async function runInspect(argv: readonly string[], io: WorkbenchCliIo): Promise<number> {
  return runWorkbenchSubcommand(
    {
      spec: WORKBENCH_SPECS.inspect,
      parse: parseInspectArgs,
      positionalCountError: PIPELINE_FILE_POSITIONAL,
      async run(parsed, commandIo) {
        const loaded = await loadParsedPlanSource(parsed, commandIo, INSPECT_USAGE);
        if ("exitCode" in loaded) return loaded.exitCode;

        const { view } = loaded;
        const completePlan = view.plan();
        const plan = {
          ...completePlan,
          steps: querySteps(completePlan, {
            tags: parsed.values.tag,
            owner: parsed.values.owner,
            domain: parsed.values.domain,
          }),
        };
        const filtered =
          parsed.values.tag !== undefined ||
          parsed.values.owner !== undefined ||
          parsed.values.domain !== undefined;
        const matchingIds = new Set(plan.steps.map((step) => step.id));
        const stepIds = view.stepIds.filter((id) => !filtered || matchingIds.has(id));
        if (parsed.values.json) {
          const inspection: WorkbenchInspection = {
            pipelineId: view.id,
            targetIds: [...view.targetIds],
            stepIds,
            plan,
          };
          commandIo.stdout.write(`${JSON.stringify(inspection, null, 2)}\n`);
          return TUBELESS_WORKBENCH_EXIT_CODE.success;
        }

        const { name, description } = pipelineIdentityText(view);
        commandIo.stdout.write(
          [
            `Pipeline ${inlineText(view.id)}`,
            ...(name ? [`Name: ${name}`] : []),
            ...(description ? [`Description: ${description}`] : []),
            `Targets: ${formatIdList(view.targetIds)}`,
            `Exact steps: ${formatIdList(stepIds)}`,
            ...(plan.definition?.metadata
              ? [`Metadata: ${JSON.stringify(plan.definition.metadata)}`]
              : []),
            ...plan.steps
              .filter((step) => step.metadata)
              .map((step) => `${step.id} metadata: ${JSON.stringify(step.metadata)}`),
            ...renderPipelinePlan(plan, { explain: false }).split("\n").map(terminalSafeText),
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

const PLAN_USAGE = renderWorkbenchUsage(WORKBENCH_SPECS.plan);

function parsePlanArgs(argv: readonly string[]) {
  return parseSubcommandArgs(argv, WORKBENCH_SPECS.plan.options);
}

export async function runPlan(argv: readonly string[], io: WorkbenchCliIo): Promise<number> {
  return runWorkbenchSubcommand(
    {
      spec: WORKBENCH_SPECS.plan,
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

const GRAPH_USAGE = renderWorkbenchUsage(WORKBENCH_SPECS.graph);

function parseGraphArgs(argv: readonly string[]) {
  return parseSubcommandArgs(argv, WORKBENCH_SPECS.graph.options);
}

export async function runGraph(argv: readonly string[], io: WorkbenchCliIo): Promise<number> {
  return runWorkbenchSubcommand(
    {
      spec: WORKBENCH_SPECS.graph,
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
          includeMetadata: parsed.values.metadata,
          query: {
            tags: parsed.values.tag,
            owner: parsed.values.owner,
            domain: parsed.values.domain,
          },
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
