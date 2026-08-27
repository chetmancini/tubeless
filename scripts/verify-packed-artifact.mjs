import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { packedTarballFilename, resolveNpm } from "./resolve-npm.mjs";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packageJson = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
const temporaryRoot = mkdtempSync(join(tmpdir(), "tubeless-pack-"));
const npm = resolveNpm();

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", stdio: "pipe" });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`.trim()
    );
  }
  return result.stdout;
}

function runWithStatus(command, args, cwd, expectedStatus) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", stdio: "pipe" });
  if (result.status !== expectedStatus) {
    throw new Error(
      `${command} ${args.join(" ")} exited ${result.status}, expected ${expectedStatus}:\n${result.stdout}\n${result.stderr}`.trim()
    );
  }
  return result;
}

try {
  const packedStdout = run(
    npm,
    ["pack", "--ignore-scripts", "--json", "--pack-destination", temporaryRoot],
    packageRoot
  );
  const tarball = join(temporaryRoot, packedTarballFilename(packedStdout));
  const consumerRoot = join(temporaryRoot, "consumer");
  mkdirSync(consumerRoot);
  writeFileSync(
    join(consumerRoot, "package.json"),
    JSON.stringify({ name: "tubeless-packed-smoke", private: true, type: "module" })
  );
  run(
    npm,
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock", tarball],
    consumerRoot
  );

  const installedPackage = join(consumerRoot, "node_modules", packageJson.name);
  for (const relativePath of [
    "README.md",
    "LICENSE",
    "docs/README.md",
    "docs/agent-guide.md",
    "docs/api-reference.md",
    "docs/api-report.json",
    "docs/child-pipeline-composition.md",
    "docs/cli.md",
    "docs/concepts.md",
    "docs/getting-started.md",
    "docs/llms.txt",
    "docs/recipes.md",
    "docs/studio.md",
    "examples/typed-import.ts",
  ]) {
    if (!existsSync(join(installedPackage, relativePath))) {
      throw new Error(`Packed tubeless artifact is missing ${relativePath}`);
    }
  }
  if (existsSync(join(installedPackage, "evals"))) {
    throw new Error("Packed tubeless artifact must not include evals/");
  }
  if (existsSync(join(installedPackage, "docs", "agent-evaluations.md"))) {
    throw new Error("Packed tubeless artifact must not include docs/agent-evaluations.md");
  }

  const smokeProgram = Object.keys(packageJson.exports)
    .map((subpath) =>
      JSON.stringify(subpath === "." ? packageJson.name : `${packageJson.name}/${subpath.slice(2)}`)
    )
    .map((specifier) => `await import(${specifier});`)
    .join("\n");
  run("node", ["--input-type=module", "--eval", smokeProgram], consumerRoot);

  const pipelineFixture = join(consumerRoot, "pipeline.mjs");
  writeFileSync(
    pipelineFixture,
    `import { createSteps, definePipeline } from "tubeless";
import { definePipelineCommand } from "tubeless/cli";
const step = createSteps();
const load = step("load", {
  description: "Load input",
  run: (_inputs, context) => {
    if (context.options.mode === "failure") throw new Error("packed command failure");
    if (context.options.mode === "cancel") {
      throw new DOMException("packed command cancellation", "AbortError");
    }
    return context.options.message;
  },
});
const write = step("write", {
  dependsOn: [load],
  description: "Write output",
  dryRun: "skip",
  run: ({ load }) => \`written:\${load}\`,
});
export const FixturePipeline = definePipeline({
  id: "fixture",
  steps: [load, write],
  targets: [write],
  finalize: (outputs) => outputs.write,
});
export const FixtureCommand = definePipelineCommand(FixturePipeline, {
  params: {
    message: { type: "string" },
    mode: {
      type: "string",
      choices: ["success", "failure", "cancel"],
      default: "success",
    },
  },
  reporter: false,
  summarize: (result) => [\`completed:\${result}\`],
});
`
  );
  const tubelessBin = join(consumerRoot, "node_modules", ".bin", "tubeless");
  if (!existsSync(tubelessBin)) {
    throw new Error("Packed tubeless artifact is missing the tubeless executable");
  }
  const inspection = JSON.parse(
    run(tubelessBin, ["inspect", "--json", pipelineFixture], consumerRoot)
  );
  if (
    inspection.pipelineId !== "fixture" ||
    inspection.targetIds[0] !== "write" ||
    inspection.plan?.steps[1]?.dryRun !== "skip"
  ) {
    throw new Error(
      `Packed tubeless inspect returned an invalid inspection:\n${JSON.stringify(inspection)}`
    );
  }
  const plan = JSON.parse(
    run(
      tubelessBin,
      ["plan", "--target", "write", "--dry-run", "--json", pipelineFixture],
      consumerRoot
    )
  );
  if (
    plan.pipelineId !== "fixture" ||
    plan.ok !== true ||
    plan.steps.find(({ id }) => id === "load")?.selected !== true ||
    plan.steps.find(({ id }) => id === "write")?.skipReason !== "dry-run"
  ) {
    throw new Error(`Packed tubeless plan returned an invalid plan:\n${JSON.stringify(plan)}`);
  }
  const diagram = run(tubelessBin, ["graph", pipelineFixture], consumerRoot);
  if (!diagram.includes('step0["load"]') || !diagram.includes("step0 --> step1")) {
    throw new Error(`Packed tubeless graph returned an invalid diagram:\n${diagram}`);
  }
  const successfulRun = runWithStatus(
    tubelessBin,
    ["run", pipelineFixture, "--", "--message", "packed"],
    consumerRoot,
    0
  );
  if (!successfulRun.stdout.includes("completed:written:packed")) {
    throw new Error(`Packed tubeless run returned invalid output:\n${successfulRun.stdout}`);
  }
  const validationRun = runWithStatus(tubelessBin, ["run", pipelineFixture], consumerRoot, 4);
  if (!validationRun.stderr.includes("Missing required option --message")) {
    throw new Error(`Packed tubeless run omitted validation output:\n${validationRun.stderr}`);
  }
  const planningRun = runWithStatus(
    tubelessBin,
    ["plan", pipelineFixture, "--target", "write", "--target", "write"],
    consumerRoot,
    5
  );
  if (!planningRun.stdout.includes("TUBELESS_PLANNING_TARGET_SELECTION_DUPLICATE")) {
    throw new Error(`Packed tubeless plan omitted planning output:\n${planningRun.stdout}`);
  }
  const failedRun = runWithStatus(
    tubelessBin,
    ["run", pipelineFixture, "--", "--message", "packed", "--mode", "failure"],
    consumerRoot,
    6
  );
  if (!failedRun.stderr.includes("TUBELESS_STEP_FAILED")) {
    throw new Error(`Packed tubeless run omitted failure output:\n${failedRun.stderr}`);
  }
  const cancelledRun = runWithStatus(
    tubelessBin,
    ["run", pipelineFixture, "--", "--message", "packed", "--mode", "cancel"],
    consumerRoot,
    7
  );
  if (!cancelledRun.stderr.includes("TUBELESS_RUN_CANCELLED")) {
    throw new Error(`Packed tubeless run omitted cancellation output:\n${cancelledRun.stderr}`);
  }

  process.stdout.write(
    "Packed tubeless artifact imports, executable, and documentation verified.\n"
  );
} finally {
  rmSync(temporaryRoot, { force: true, recursive: true });
}
