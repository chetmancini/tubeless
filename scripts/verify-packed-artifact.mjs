import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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

function assertPackedMarkdownLinks(filePath, packedName) {
  const source = readFileSync(filePath, "utf8");
  const links = source.matchAll(/\[[^\]]*\]\(([^)]+)\)/g);
  for (const match of links) {
    const target = match[1].replace(/^<|>$/g, "").split("#", 1)[0];
    if (!target || /^(?:https?:|mailto:)/.test(target)) continue;
    const resolved = resolve(dirname(filePath), decodeURIComponent(target));
    if (!existsSync(resolved)) {
      throw new Error(`Packed ${packedName} links to missing ${target}`);
    }
  }
}

function assertPackedLlmsLinks(docsDirectory) {
  const source = readFileSync(join(docsDirectory, "llms.txt"), "utf8");
  for (const line of source.split("\n")) {
    const match = line.match(/(?:\.\.\/|\.\/)\S+/);
    if (!match) continue;
    const target = match[0].split("#", 1)[0];
    const resolved = resolve(docsDirectory, decodeURIComponent(target));
    if (!existsSync(resolved)) {
      throw new Error(`Packed docs/llms.txt links to missing ${target}`);
    }
  }
}

function assertPackedDocumentationLinks(installedPackage) {
  const packedDocs = join(installedPackage, "docs");
  for (const name of readdirSync(packedDocs)) {
    if (!name.endsWith(".md")) continue;
    assertPackedMarkdownLinks(join(packedDocs, name), `docs/${name}`);
  }
  assertPackedLlmsLinks(packedDocs);
}

function assertPackedExampleCli(tubelessBin, installedPackage, consumerRoot) {
  const typedImport = join(installedPackage, "examples", "typed-import.ts");
  const cliJob = join(installedPackage, "examples", "cli-job.ts");
  const inspection = JSON.parse(
    run(tubelessBin, ["inspect", "--json", "--export", "ImportPipeline", typedImport], consumerRoot)
  );
  if (inspection.pipelineId !== "import") {
    throw new Error(
      `Packed example inspect returned an invalid inspection:\n${JSON.stringify(inspection)}`
    );
  }
  const plan = JSON.parse(
    run(
      tubelessBin,
      [
        "plan",
        "--json",
        "--export",
        "ImportPipeline",
        "--target",
        "normalize-rows",
        "--explain",
        typedImport,
      ],
      consumerRoot
    )
  );
  const normalizeRows = plan.steps?.find(({ id }) => id === "normalize-rows");
  if (plan.ok !== true || normalizeRows?.selected !== true) {
    throw new Error(`Packed example plan returned an invalid plan:\n${JSON.stringify(plan)}`);
  }
  const diagram = run(
    tubelessBin,
    ["graph", "--export", "ImportPipeline", typedImport],
    consumerRoot
  );
  if (!diagram.includes("-->")) {
    throw new Error(`Packed example graph omitted a Mermaid edge:\n${diagram}`);
  }
  const sourceFile = join(consumerRoot, "import-source.txt");
  writeFileSync(sourceFile, "Alpha\nBeta\n");
  const successfulRun = runWithStatus(
    tubelessBin,
    ["run", "--export", "ImportCommand", cliJob, "--", "--source", sourceFile],
    consumerRoot,
    0
  );
  if (!successfulRun.stdout.includes("Normalized")) {
    throw new Error(`Packed example run omitted summarize output:\n${successfulRun.stdout}`);
  }
}

function assertPackedExampleModules(consumerRoot, installedPackage) {
  const packedExamples = join(installedPackage, "examples");
  const examplesDirectory = join(consumerRoot, "packed-examples");
  mkdirSync(examplesDirectory);
  for (const name of readdirSync(packedExamples)) {
    if (!name.endsWith(".ts")) continue;
    writeFileSync(join(examplesDirectory, name), readFileSync(join(packedExamples, name)));
  }
  const recipesPath = join(installedPackage, "docs", "recipes.md");
  const checkpointPath = join(consumerRoot, "enrichment-checkpoint.json");
  const program = `
const { existsSync, readFileSync } = await import("node:fs");
const { join } = await import("node:path");
const { pathToFileURL } = await import("node:url");

const examplesDirectory = ${JSON.stringify(examplesDirectory)};
const recipesPath = ${JSON.stringify(recipesPath)};
const checkpointPath = ${JSON.stringify(checkpointPath)};

function fail(example, detail) {
  throw new Error(example + ": " + detail);
}

function defined(value, example) {
  if (value === undefined) fail(example, "returned undefined");
  return value;
}

async function loadExample(file) {
  return import(pathToFileURL(join(examplesDirectory, file)).href);
}

const runners = {
  "typed-import.ts": async (mod) => {
    defined(await mod.runImportExample(), "typed-import.ts");
  },
  "validated-boundaries.ts": async (mod) => {
    defined(await mod.runValidatedExample(), "validated-boundaries.ts");
  },
  "publish-with-gates.ts": async (mod) => {
    defined(await mod.runPublishDryRunExample(), "publish-with-gates.ts");
  },
  "conditional-step.ts": async (mod) => {
    defined(await mod.runConditionalCacheExample(), "conditional-step.ts");
  },
  "best-effort.ts": async (mod) => {
    defined(await mod.runBestEffortExample(), "best-effort.ts");
  },
  "child-pipeline.ts": async (mod) => {
    defined(await mod.runChildPipelineExample(), "child-pipeline.ts");
  },
  "fan-out-progress.ts": async (mod) => {
    defined(
      await mod.FanOutPipeline.runOrThrow({
        concurrency: 1,
        shards: [{ id: "s", records: ["a"] }],
      }),
      "fan-out-progress.ts"
    );
  },
  "live-tui.ts": async (mod) => {
    defined(await mod.LiveTuiPipeline.runOrThrow({ delay: 0 }), "live-tui.ts");
  },
  "peloton.ts": async (mod) => {
    defined(await mod.runPelotonExample(), "peloton.ts");
  },
  "resumable-enrichment.ts": async (mod) => {
    const result = await mod.EnrichmentPipeline.run({
      checkpointPath: "enrichment-checkpoint.json",
      dryRun: true,
      items: ["a"],
    });
    if (result.status !== "completed") fail("resumable-enrichment.ts", "status " + result.status);
    if (existsSync(checkpointPath)) fail("resumable-enrichment.ts", "dry-run created a checkpoint");
  },
  "cli-job.ts": async (mod) => {
    defined(mod.ImportCommand, "cli-job.ts");
  },
  "rendering.ts": async (mod) => {
    if (typeof mod.humanPlan !== "string") fail("rendering.ts", "humanPlan is not a string");
    if (typeof mod.jsonPlan !== "string" || mod.jsonPlan.length === 0) {
      fail("rendering.ts", "jsonPlan is empty");
    }
    if (!mod.humanPlan.includes("publish") && !mod.humanPlan.includes("release")) {
      fail("rendering.ts", "humanPlan omitted publish or release");
    }
  },
  "cancellation-and-testing.ts": async (mod) => {
    defined(await mod.runWithTestRuntime(), "cancellation-and-testing.ts");
  },
  "tracing.ts": async (mod) => {
    const value = await mod.runTracingExample([" Alpha "]);
    if (!Array.isArray(value) || value.some((row) => row !== row.toLowerCase())) {
      fail("tracing.ts", "expected a lowercased array");
    }
  },
  "local-observability.ts": async (mod) => {
    const snapshot = mod.snapshotFromPages([[]]);
    if (!snapshot || !Array.isArray(snapshot.runs)) {
      fail("local-observability.ts", "snapshotFromPages omitted a runs array");
    }
  },
};

const recipes = readFileSync(recipesPath, "utf8");
const linked = [
  ...new Set([...recipes.matchAll(/\\.\\.\\/examples\\/([a-z0-9-]+\\.ts)/g)].map((match) => match[1])),
];
for (const file of linked) {
  const runner = runners[file];
  if (!runner) fail(file, "no packed-example runner");
  await runner(await loadExample(file));
}
`;
  run("node", ["--input-type=module", "--eval", program], consumerRoot);
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
    "examples/catalog/tubeless.studio.ts",
    "examples/catalog/pipelines/import.ts",
    "examples/catalog/scripts/import.ts",
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
  assertPackedDocumentationLinks(installedPackage);

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

  assertPackedExampleCli(tubelessBin, installedPackage, consumerRoot);
  assertPackedExampleModules(consumerRoot, installedPackage);

  process.stdout.write(
    "Packed tubeless artifact imports, executable, documentation, and examples verified.\n"
  );
} finally {
  rmSync(temporaryRoot, { force: true, recursive: true });
}
