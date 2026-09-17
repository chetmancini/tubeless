import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { PipelineDocumentError, validatePipelineDocument } from "../project/project.js";
import {
  errorMessage,
  TUBELESS_WORKBENCH_EXIT_CODE,
  type WorkbenchCliIo,
} from "./workbench-shared.js";
import { runWorkbenchSubcommand } from "./workbench-subcommand.js";

const VALIDATE_USAGE = `Usage: tubeless validate [--json] <document.yaml|document.yml|document.json>

Check pipeline document structure and metadata without importing handlers.
Does not check graph semantics, registered names, or domain values. Use inspect
or plan on the compiled command module for engine validation.
YAML uses Bun's parser; duplicate mapping keys may be overwritten during parsing.

Options:
      --json   Emit a structured validation result
  -h, --help   Show this help
`;

export async function runValidate(argv: readonly string[], io: WorkbenchCliIo): Promise<number> {
  return runWorkbenchSubcommand(
    {
      usage: VALIDATE_USAGE,
      parse: (args) =>
        parseArgs({
          args: [...args],
          allowPositionals: true,
          strict: true,
          options: {
            help: { type: "boolean", short: "h" },
            json: { type: "boolean" },
          },
        }),
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
