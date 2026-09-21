import { createSteps, definePipeline } from "tubeless";
import { defineProject, type PipelineProject, type ProjectOptions } from "tubeless/project";
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
  const metadata: ProjectOptions = {
    name: "Echo jobs",
    description: "Echo a message.",
  };
  return defineProject("packed-project", [command], metadata);
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

function selectUnionPipeline(id: "echo" | "echo-alias", lookup: "echo" | "packed-cli-types") {
  const unionPipeline = definePipeline({ id, steps: [echo] });
  const project = defineProject("union-ids", [command, unionPipeline]);
  const selected = project.get("echo");
  const selectedId: "echo" | "echo-alias" = selected.id;
  selected.plan();
  // @ts-expect-error Union-id lookups retain the required domain input.
  selected.runOrThrow({});
  const either: typeof pipeline | typeof unionPipeline = project.get(lookup);
  either.plan();
  void selectedId;
}

function selectWidenedPipeline(id: string, lookup: string) {
  const widePipeline = definePipeline({ id, steps: [echo] });
  const project = defineProject("wide-ids", [
    command,
    definePipelineCommand(widePipeline, {
      params: { message: { type: "string" } },
    }),
  ]);
  const selected: typeof pipeline | typeof widePipeline = project.get(lookup);
  selected.plan();
  // @ts-expect-error Widened-id lookups retain the required domain input.
  selected.runOrThrow({});
}

selectUnionPipeline("echo", "echo");
selectWidenedPipeline("dynamic", "dynamic");

type EchoResult = { message: string };
const typedResult = definePipeline({
  id: "typed-result",
  steps: [echo],
  finalize: (outputs): EchoResult => ({ message: outputs.echo ?? "" }),
});
const typedResultProject = defineProject("typed-result-project", [typedResult]);
const typedResultId: "typed-result" = typedResult.id;
const typedResultValue: Promise<EchoResult> = typedResultProject
  .get("typed-result")
  .runOrThrow({ message: "hello" });
// @ts-expect-error Annotating the finalizer preserves the exact project lookup id.
typedResultProject.get("missing");
void typedResultId;
void typedResultValue;
