import { createSteps, definePipeline } from "tubeless";
import {
  definePipelineCommand,
  type CliContext,
  type PipelineReporterConfig,
  type PipelineReporterMode,
  type ReporterColorMode,
  type ReporterOutput,
  type ReporterSymbolMode,
  type ReporterTerminalCapabilities,
  type RunReporterConfig,
} from "tubeless/cli";

const env: CliContext["env"] = { CI: "true", OPTIONAL: undefined };
const mode: PipelineReporterMode = "plain";
const color: ReporterColorMode = "never";
const symbols: ReporterSymbolMode = "ascii";
const terminal: ReporterTerminalCapabilities = { color: false, isTTY: false, unicode: false };
const output: ReporterOutput = { write: (_chunk) => undefined };
const base: RunReporterConfig = { color, symbols, terminal, logPlan: false };
const reporter: PipelineReporterConfig = { ...base, mode, output, progressBarWidth: 12 };

const step = createSteps<{ message: string }>();
const echo = step("echo", { run: (_inputs, context) => context.options.message });
const pipeline = definePipeline({
  id: "packed-cli-types",
  steps: [echo],
  finalize: (outputs) => outputs.echo,
});
const command = definePipelineCommand(pipeline, {
  params: { message: { type: "string", env: "MESSAGE" } },
  reporter,
});

command.parse([], { env });
