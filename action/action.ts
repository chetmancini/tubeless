import {
  cloudRunBlocked,
  displayArgs,
  graphArgs,
  planArgs,
  renderReport,
  runArgs,
  type ActionRequest,
  type CommandResult,
} from "./report.js";

export interface ActionHost {
  run(args: readonly string[]): CommandResult;
  writeSummary(markdown: string): void;
  writeOutputs(outputs: { readonly plan: string; readonly mermaid: string }): void;
  comment(body: string): Promise<void>;
  log(line: string): void;
}

export async function executeAction(request: ActionRequest, host: ActionHost): Promise<number> {
  if (request.pipeline === "") throw new Error("pipeline is required.");

  const planCommand = planArgs(request.pipeline, request.mode);
  host.log(`tubeless ${displayArgs(planCommand)}`);
  const plan = host.run(planCommand);

  const graphCommand = graphArgs(request.pipeline);
  host.log(`tubeless ${displayArgs(graphCommand)}`);
  const graph = host.run(graphCommand);

  // TODO(tubeless-cloud): When cloud-token is set and mode is run, POST the run
  // to the Tubeless Cloud HTTP API instead of invoking `tubeless run`.
  // docs/cli.md documents `tubeless cloud run` only. src/workbench/cloud/protocol.ts
  // marks that HTTP transport as an internal CLI contract, and this repository
  // does not document a public request shape. Skip dispatch until it does, and
  // do not run the pipeline locally in its place.
  const cloudBlocked = cloudRunBlocked(request.mode, request.cloudToken);
  let execution: CommandResult | undefined;
  if (!cloudBlocked) {
    const executionCommand = runArgs(request.pipeline, request.mode);
    if (executionCommand) {
      host.log(`tubeless ${displayArgs(executionCommand)}`);
      execution = host.run(executionCommand);
    }
  }

  const markdown = renderReport({
    pipeline: request.pipeline,
    mode: request.mode,
    plan,
    graph,
    ...(execution ? { execution } : {}),
    cloudBlocked,
  });
  host.writeOutputs({
    plan: plan.stdout,
    mermaid: graph.exitCode === 0 ? graph.stdout.trim() : "",
  });
  if (request.summary) host.writeSummary(markdown);
  if (request.comment) {
    if (request.pullRequest === undefined) host.log("No pull request; skipped the sticky comment.");
    else await host.comment(markdown);
  }

  const failed = [plan, graph, execution].find(
    (result) => result !== undefined && result.exitCode !== 0
  );
  if (failed) return failed.exitCode;
  if (cloudBlocked) return 1;
  return 0;
}
