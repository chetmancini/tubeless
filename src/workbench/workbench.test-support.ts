import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, unlink, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { WorkbenchCliIo } from "./workbench.js";

export const execFileAsync = promisify(execFile);

export async function directoryIgnoresCase(dir: string): Promise<boolean> {
  const probe = path.join(dir, ".tubeless-case-test-a");
  const flipped = path.join(dir, ".tubeless-case-test-A");
  await writeFile(probe, "", { flag: "wx" });
  try {
    return existsSync(flipped);
  } finally {
    await unlink(probe).catch(() => {});
  }
}

export function parseNdjson(
  text: string
): { name?: string; pipelineId?: string; runId?: string }[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        // SAFETY: successful JSON parses are narrowed to the fields inspected by these tests.
        return [JSON.parse(line) as { name?: string; pipelineId?: string; runId?: string }];
      } catch {
        return [];
      }
    });
}

export function captureIo(cwd: string): WorkbenchCliIo & { errors: string[]; output: string[] } {
  const errors: string[] = [];
  const output: string[] = [];
  return {
    cwd,
    errors,
    output,
    stderr: {
      write: (chunk) => {
        errors.push(chunk);
      },
    },
    stdout: {
      write: (chunk) => {
        output.push(chunk);
      },
    },
  };
}

export async function writeModule(
  source: string
): Promise<{ directory: string; filePath: string }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tubeless-workbench-"));
  const filePath = path.join(directory, "pipeline.mjs");
  await writeFile(filePath, source);
  return { directory, filePath };
}

export async function writeActualPipelineModule(): Promise<{
  directory: string;
  filePath: string;
}> {
  const pipelineModuleUrl = pathToFileURL(path.resolve("dist/core/pipeline.js")).href;
  return writeModule(`
    import { createSteps, definePipeline } from ${JSON.stringify(pipelineModuleUrl)};
    const { step } = createSteps();
    const load = step("load", {
      description: "Load source data.",
      run: () => { throw new Error("plan must not execute load"); },
    });
    const hint = step("hint", {
      run: () => { throw new Error("plan must not execute hint"); },
    });
    const publish = step("publish", {
      dependsOn: [load],
      optionalDependsOn: [hint],
      description: "Publish the artifact.",
      dryRun: "skip",
      run: () => { throw new Error("plan must not execute publish"); },
    });
    export const PlanningPipeline = definePipeline({
      id: "planning-fixture",
      steps: [load, hint, publish],
      targets: [publish],
      finalize: () => undefined,
    });
  `);
}

export async function writeActualPipelineCommandModule(): Promise<{
  directory: string;
  filePath: string;
}> {
  const cliModuleUrl = pathToFileURL(path.resolve("dist/cli/cli.js")).href;
  const pipelineModuleUrl = pathToFileURL(path.resolve("dist/core/pipeline.js")).href;
  return writeModule(`
    import { definePipelineCommand } from ${JSON.stringify(cliModuleUrl)};
    import { createSteps, definePipeline, requireOutputs } from ${JSON.stringify(pipelineModuleUrl)};
    let markStarted;
    export const started = new Promise((resolve) => { markStarted = resolve; });
    const { step } = createSteps();
    const work = step("work", {
      description: "Exercise workbench execution.",
      run: async (_inputs, context) => {
        markStarted();
        if (context.options.mode === "failure") throw new Error("intentional command failure");
        if (context.options.mode === "cancel") {
          throw new DOMException("intentional command cancellation", "AbortError");
        }
        if (context.options.mode === "fail-after-abort") {
          await new Promise((resolve) => {
            if (context.signal?.aborted) return resolve();
            context.signal?.addEventListener("abort", resolve, { once: true });
          });
          throw new Error("intentional failure after abort");
        }
        if (context.options.mode === "wait") {
          await new Promise((_resolve, reject) => {
            if (context.signal?.aborted) return reject(context.signal.reason);
            context.signal?.addEventListener("abort", () => reject(context.signal.reason), { once: true });
          });
        }
        context.log.log(\`worked:\${context.options.message}\`);
        return context.options.message;
      },
    });
    export const CommandPipeline = definePipeline({
      id: "command-fixture",
      steps: [work],
      targets: [work],
      finalize: requireOutputs([work], ({ work }) => work),
    });
    export const FixtureCommand = definePipelineCommand(CommandPipeline, {
      params: {
        message: { type: "string", description: "Message to process." },
        mode: {
          type: "string",
          choices: ["success", "failure", "cancel", "fail-after-abort", "wait"],
          default: "success",
        },
      },
      reporter: false,
      summarize: (result) => [\`completed:\${result}\`],
    });
  `);
}

export async function writeStudioConfig(
  directory: string,
  command: { exportName?: string; name?: string } = {}
): Promise<void> {
  const exportName = command.exportName ?? "FixtureCommand";
  const name = command.name ?? "Studio fixture";
  const projectModuleUrl = pathToFileURL(path.resolve("dist/project/project-manifest.js")).href;
  const configDirectory = path.join(directory, "config");
  await mkdir(configDirectory);
  await writeFile(
    path.join(configDirectory, "tubeless.project.mjs"),
    `
      import { definePipelineProject } from ${JSON.stringify(projectModuleUrl)};
      export default definePipelineProject({
        cwd: "..",
        commands: [{
          id: "fixture",
          file: "../pipeline.mjs",
          export: ${JSON.stringify(exportName)},
          name: ${JSON.stringify(name)},
        }],
      });
    `
  );
}

export async function writeGatedPipelineCommandModule(options: {
  mapOptionsSource: string;
}): Promise<{ directory: string; filePath: string }> {
  const cliModuleUrl = pathToFileURL(path.resolve("dist/cli/cli.js")).href;
  const pipelineModuleUrl = pathToFileURL(path.resolve("dist/core/pipeline.js")).href;
  return writeModule(`
    import { existsSync } from "node:fs";
    import { definePipelineCommand } from ${JSON.stringify(cliModuleUrl)};
    import { createSteps, definePipeline } from ${JSON.stringify(pipelineModuleUrl)};
    const { step } = createSteps();
    const work = step("work", {
      description: "No-op gated command.",
      run: () => undefined,
    });
    export const GatedCommand = definePipelineCommand(
      definePipeline({
        id: "gated-fixture",
        steps: [work],
        targets: [work],
        finalize: () => undefined,
      }),
      {
        params: { message: { type: "string" } },
        mapOptions: ${options.mapOptionsSource},
        reporter: false,
      }
    );
  `);
}

export const fixturePipeline = `
const steps = [
  {
    dependencies: [],
    description: "Read source rows.",
    dryRun: "run",
    id: "load",
    name: "Load Rows",
    optionalDependencies: [],
    runtimeSkipPossible: false,
    selected: true,
    selectionReasons: [{ kind: "all" }],
    skipAfterFailureOf: [],
  },
  {
    dependencies: ["load"],
    description: "Publish output.",
    dryRun: "skip",
    id: "publish",
    optionalDependencies: ["hint"],
    runtimeSkipPossible: true,
    selected: true,
    selectionReasons: [{ kind: "all" }],
    skipAfterFailureOf: ["validate"],
  },
];
export const FixturePipeline = {
  id: "fixture",
  stepIds: ["load", "publish"],
  targetIds: ["publish"],
  plan: () => ({ dryRun: false, errors: [], ok: true, pipelineId: "fixture", steps }),
  toMermaid(options = {}) {
    const label = options.includeDescriptions ? "Load Rows — Read source rows." : "Load Rows";
    return \`flowchart \${options.direction ?? "TD"}\\n  step0["\${label}"]\\n  step0 --> step1\`;
  },
};
`;
