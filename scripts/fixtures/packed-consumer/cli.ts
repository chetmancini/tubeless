import { createSteps, definePipeline } from "tubeless";
import { defineProject, type PipelineProject, type ProjectMetadata } from "tubeless/project";
import {
  definePipelineCommand,
  type CliContext,
  type PipelineReporterConfig,
  type PipelineReporterMode,
  type ReporterColorMode,
  type ReporterOutput,
  type ReporterSymbolMode,
  type ReporterTerminalCapabilities,
} from "tubeless/cli";

const env: CliContext["env"] = { CI: "true", OPTIONAL: undefined };
const mode: PipelineReporterMode = "plain";
const color: ReporterColorMode = "never";
const symbols: ReporterSymbolMode = "ascii";
const terminal: ReporterTerminalCapabilities = { color: false, isTTY: false, unicode: false };
const output: ReporterOutput = { write: (_chunk) => undefined };
const reporter: PipelineReporterConfig = {
  color,
  symbols,
  terminal,
  logPlan: false,
  mode,
  output,
  progressBarWidth: 12,
};

const { step } = createSteps<{ message: string }>();
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

type EchoProject = PipelineProject<"packed-project", readonly [typeof pipeline]>;

function createEchoProject(): EchoProject {
  const metadata: ProjectMetadata = { name: "Echo jobs", description: "Echo a message." };
  return defineProject("packed-project", [pipeline], metadata);
}

function selectEcho(project: EchoProject): typeof pipeline {
  const projectId: "packed-project" = project.id;
  const pipelineIds: readonly ["packed-cli-types"] = project.pipelineIds;
  const name: string = project.name;
  const description: string | undefined = project.description;
  // @ts-expect-error Project presentation is immutable.
  project.name = "Changed";
  // @ts-expect-error Only this project's pipeline ids are accepted.
  project.get("missing");
  // @ts-expect-error The selected pipeline retains its required message input.
  project.get("packed-cli-types").runOrThrow({});
  void projectId;
  void pipelineIds;
  void name;
  void description;
  return project.get("packed-cli-types");
}

selectEcho(createEchoProject());
