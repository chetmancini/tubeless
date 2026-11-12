import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { packedTarballFilename, resolveNpm } from "./resolve-npm.mjs";

const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number);
if (nodeMajor < 22 || (nodeMajor === 22 && nodeMinor < 18)) {
  throw new Error(
    `Packed-artifact verification requires Node.js 22.18 or later; found ${process.versions.node}.`
  );
}

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packageJson = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
const floorPackagePath = join(packageRoot, "node_modules/typescript-floor/package.json");
if (!existsSync(floorPackagePath)) {
  throw new Error(
    "Packed-artifact verification requires the pinned typescript-floor dev dependency."
  );
}
const floorVersion = JSON.parse(readFileSync(floorPackagePath, "utf8")).version;
// The documented floor must name the compiler actually verified, or the claim drifts.
const floorMajorMinor = floorVersion.split(".").slice(0, 2).join(".");
if (
  !readFileSync(join(packageRoot, "docs/getting-started.md"), "utf8").includes(
    `TypeScript ${floorMajorMinor} or later`
  )
) {
  throw new Error(
    `docs/getting-started.md must state "TypeScript ${floorMajorMinor} or later" for typescript-floor ${floorVersion}.`
  );
}
const temporaryRoot = mkdtempSync(join(tmpdir(), "tubeless-pack-"));
const npm = resolveNpm();

// The pinned compiler serves the repository and is the resolution target for `bunx tsc`;
// the floor compiler is the oldest standard compiler the published declarations support.
const compilers = [
  {
    label: `typescript ${packageJson.devDependencies.typescript}`,
    command: join(packageRoot, "node_modules/typescript/bin/tsc"),
    args: [],
  },
  {
    label: `typescript-floor ${floorVersion}`,
    command: process.execPath,
    args: [join(packageRoot, "node_modules/typescript-floor/bin/tsc")],
  },
];

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", stdio: "pipe" });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`.trim()
    );
  }
  return result.stdout;
}

// Name the compiler and the module resolution on failure: these compiles share one path.
function compileConsumer(compiler, compilation, cwd) {
  const resolution = compilation.moduleResolution ?? compilation.module;
  try {
    run(compiler.command, [...compiler.args, "-p", compilation.tsconfig], cwd);
  } catch (error) {
    throw new Error(`${compiler.label} / ${resolution}: ${error.message}`);
  }
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

function assertPackedSourceMaps(installedPackage) {
  const distDirectory = join(installedPackage, "dist");
  const entries = readdirSync(distDirectory, { recursive: true });
  const declarationMaps = entries.filter((name) => name.endsWith(".d.ts.map"));
  if (declarationMaps.length > 0) {
    throw new Error(
      `Packed tubeless artifact must not include dangling declaration maps: ${declarationMaps.join(", ")}`
    );
  }
  const javaScriptMaps = entries.filter((name) => name.endsWith(".js.map"));
  if (javaScriptMaps.length === 0) {
    throw new Error("Packed tubeless artifact is missing dist source maps");
  }
  for (const name of javaScriptMaps) {
    const map = JSON.parse(readFileSync(join(distDirectory, name), "utf8"));
    if (
      !Array.isArray(map.sourcesContent) ||
      map.sourcesContent.length !== map.sources?.length ||
      map.sourcesContent.some((source) => typeof source !== "string" || source.length === 0)
    ) {
      throw new Error(`Packed tubeless artifact map dist/${name} is missing inline sourcesContent`);
    }
    const pairedJavaScript = name.slice(0, -".map".length);
    const pairedPath = join(distDirectory, pairedJavaScript);
    const pairedSource = existsSync(pairedPath) ? readFileSync(pairedPath, "utf8") : "";
    if (!pairedSource.includes(`sourceMappingURL=${basename(name)}`)) {
      throw new Error(
        `Packed tubeless artifact map dist/${name} is not referenced by dist/${pairedJavaScript}`
      );
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

function assertPackedLauncher(installedPackage, tubelessBin, consumerRoot) {
  const launcher = join(installedPackage, "dist", "workbench", "workbench-launcher.js");
  if (!readFileSync(launcher, "utf8").startsWith("#!/usr/bin/env node")) {
    throw new Error("Packed tubeless launcher is not a Node.js executable");
  }
  // The installed bin must start on Node.js and explain what to install when Bun
  // is absent. A PATH holding only a `node` symlink resolves the shebang while
  // hiding every other executable, Bun included.
  const nodeOnlyPath = join(temporaryRoot, "node-only-bin");
  mkdirSync(nodeOnlyPath, { recursive: true });
  symlinkSync(process.execPath, join(nodeOnlyPath, "node"));
  const result = spawnSync(tubelessBin, ["--help"], {
    cwd: consumerRoot,
    encoding: "utf8",
    env: { ...process.env, PATH: nodeOnlyPath },
  });
  if (result.status !== 1 || result.stdout !== "" || !result.stderr.includes("https://bun.sh")) {
    throw new Error(
      `Packed tubeless launcher without Bun returned status ${result.status}:\n${result.stdout}\n${result.stderr}`
    );
  }
}

function assertPackedExecutable(tubelessBin, installedPackage, consumerRoot) {
  const cliJob = join(installedPackage, "examples", "cli-job.ts");
  const sourceFile = join(consumerRoot, "import-source.txt");
  writeFileSync(sourceFile, "Alpha\nBeta\n");
  const output = run(
    tubelessBin,
    ["run", "--export", "ImportCommand", cliJob, "--", "--source", sourceFile],
    consumerRoot
  );
  if (!output.includes("Normalized 2 row(s).")) {
    throw new Error(`Packed executable returned invalid output:\n${output}`);
  }
  // Exercise dynamic tools, recoverable failure and subagents through an ordinary
  // pipeline from the installed artifact. Neither run needs model credentials.
  for (const controls of [[], ["--dry-run"]]) {
    const answer = run(
      tubelessBin,
      [
        "run",
        join(installedPackage, "examples", "agent-pipeline.ts"),
        "--",
        ...controls,
        "--question",
        "red missing",
      ],
      consumerRoot
    );
    if (
      !answer.includes(
        "Summary: 3 characters; RED | 7 characters; Observed NOT_FOUND: Word unavailable"
      )
    ) {
      throw new Error(`Packed agent recipe returned invalid output:\n${answer}`);
    }
  }
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
    "docs/agent-skills.md",
    "skills/tubeless/SKILL.md",
    "skills/tubeless-make-pipeline/SKILL.md",
    "docs/api-reference.md",
    "docs/api-report.json",
    "docs/pipeline-document.schema.json",
    "docs/child-pipeline-composition.md",
    "docs/agents.md",
    "examples/agent.ts",
    "examples/agent-workspace.ts",
    "examples/agent-model.ts",
    "examples/agent-model-anthropic.ts",
    "examples/agent-delegation.ts",
    "examples/agent-pipeline.ts",
    "examples/agent-openai.ts",
    "examples/agent-mcp.ts",
    "examples/agent-codemode.ts",
    "examples/agent-extract.ts",
    "docs/remote-step-composition.md",
    "docs/cli.md",
    "docs/concepts.md",
    "docs/getting-started.md",
    "docs/llms.txt",
    "docs/recipes.md",
    "docs/studio.md",
    "examples/typed-import.ts",
    "examples/project/tubeless.project.ts",
    "examples/project/pipelines/import.ts",
    "examples/project/pipelines/enrich.ts",
    "examples/project/scripts/import.ts",
    "examples/project/scripts/enrich.ts",
  ]) {
    if (!existsSync(join(installedPackage, relativePath))) {
      throw new Error(`Packed tubeless artifact is missing ${relativePath}`);
    }
  }
  if (existsSync(join(installedPackage, "docs", "superpowers"))) {
    throw new Error("Packed tubeless artifact must not include docs/superpowers");
  }
  if (existsSync(join(installedPackage, "design"))) {
    throw new Error("Packed tubeless artifact must not include design prototypes");
  }
  assertPackedSourceMaps(installedPackage);
  assertPackedDocumentationLinks(installedPackage);

  // Consumer declarations must compile without ambient Node typings or skipLibCheck.
  // Every fixture is copied and compiled, so a new entry-point fixture needs no script edit.
  const fixtureDirectory = join(packageRoot, "scripts/fixtures/packed-consumer");
  const fixtureFiles = readdirSync(fixtureDirectory)
    .filter((name) => name.endsWith(".ts"))
    .sort();
  const fixtureSources = fixtureFiles.map((name) => {
    const source = readFileSync(join(fixtureDirectory, name), "utf8");
    writeFileSync(join(consumerRoot, name), source);
    return source;
  });
  // An entry point no fixture imports ships declarations no consumer compilation covers.
  for (const subpath of Object.keys(packageJson.exports)) {
    const specifier =
      subpath === "." ? packageJson.name : `${packageJson.name}/${subpath.slice(2)}`;
    const statement = `from ${JSON.stringify(specifier)}`;
    if (!fixtureSources.some((source) => source.includes(statement))) {
      throw new Error(`Packed-consumer fixtures do not import ${specifier}`);
    }
  }
  const consumerCompilations = [
    { tsconfig: "tsconfig.json", module: "NodeNext" },
    { tsconfig: "tsconfig.bundler.json", module: "ESNext", moduleResolution: "Bundler" },
  ];
  for (const compilation of consumerCompilations) {
    writeFileSync(
      join(consumerRoot, compilation.tsconfig),
      JSON.stringify({
        compilerOptions: {
          // ESNext.Disposable supplies Symbol.asyncDispose, which tubeless/agent/mcp declares.
          lib: ["ES2022", "DOM", "ESNext.Disposable"],
          module: compilation.module,
          moduleResolution: compilation.moduleResolution,
          noEmit: true,
          skipLibCheck: false,
          strict: true,
          target: "ES2022",
          types: [],
        },
        files: fixtureFiles,
      })
    );
  }
  for (const compiler of compilers) {
    for (const compilation of consumerCompilations) {
      compileConsumer(compiler, compilation, consumerRoot);
    }
  }
  run("node", ["--experimental-strip-types", "project.ts"], consumerRoot);
  // The cache entry stays free of cloudflare:workers so projects using it load in Node.
  run("node", ["--experimental-strip-types", "cloudflare-cache.ts"], consumerRoot);

  // The Cloudflare entry imports cloudflare:workers, which only workerd resolves; its
  // runtime loading is covered by src/cloudflare/cloudflare-app.test.ts. The
  // tubeless/cloudflare/cache entry is not workerd-only and is imported below.
  const workerdOnlyExports = new Set(["./cloudflare"]);
  for (const relativePath of [
    "dist/cloudflare/cloudflare.js",
    "dist/cloudflare/cloudflare.d.ts",
    "dist/cloudflare/cloudflare-studio-client.js",
    "dist/cloudflare/cloudflare-studio-client.d.ts",
    "dist/cloudflare/cloudflare-cache.js",
    "dist/cloudflare/cloudflare-cache.d.ts",
  ]) {
    if (!existsSync(join(installedPackage, relativePath))) {
      throw new Error(`Packed tubeless artifact is missing ${relativePath}`);
    }
  }
  const smokeProgram = Object.keys(packageJson.exports)
    .filter((subpath) => !workerdOnlyExports.has(subpath))
    .map((subpath) =>
      JSON.stringify(subpath === "." ? packageJson.name : `${packageJson.name}/${subpath.slice(2)}`)
    )
    .map((specifier) => `await import(${specifier});`)
    .join("\n");
  run("node", ["--input-type=module", "--eval", smokeProgram], consumerRoot);

  // Exercise the worker bootstrap from the installed tarball, including file-worker
  // startup when the caller itself was launched with --input-type module.
  run(
    "node",
    [
      "--input-type",
      "module",
      "--eval",
      `
    import { createWorkerThreadAdapter } from "tubeless/node";
    import { createSteps, definePipeline } from "tubeless";
    const adapter = createWorkerThreadAdapter({
      module: new URL("data:text/javascript,export function double(value) { return value * 2; }"),
      exportName: "double",
      poolSize: 2,
    });
    const { fromRemote } = createSteps();
    const work = fromRemote("work", {
      adapter, mapInput: () => 21,
      outputSchema: { "~standard": { vendor: "smoke", version: 1,
        validate: value => typeof value === "number" ? { value } : { issues: [{ message: "number required" }] },
      } },
    });
    try {
      const result = await definePipeline({ id: "packed-worker", steps: [work] }).runOrThrow({});
      if (result !== 42) throw new Error("Invalid worker result");
    } finally { await adapter.close(); }
  `,
    ],
    consumerRoot
  );

  // Compile the shipped recipe and verify that one invocation does not close the
  // pool shared by later helper calls or direct pipeline runs.
  writeFileSync(
    join(consumerRoot, "tsconfig.worker-example.json"),
    JSON.stringify({
      compilerOptions: {
        lib: ["ES2022", "DOM"],
        module: "NodeNext",
        outDir: "worker-example",
        rootDir: join(installedPackage, "examples"),
        strict: true,
        target: "ES2022",
        types: [],
      },
      files: [
        join(installedPackage, "examples/worker-threads.ts"),
        join(installedPackage, "examples/prime-worker.ts"),
      ],
    })
  );
  run(
    compilers[0].command,
    [...compilers[0].args, "-p", "tsconfig.worker-example.json"],
    consumerRoot
  );
  run(
    "node",
    [
      "--input-type",
      "module",
      "--eval",
      `
    import { primeAdapter, runWorkerThreadsExample, WorkerPrimesPipeline } from "./worker-example/worker-threads.js";
    const expected = "[9592,17984,25997,33860]";
    try {
      for (let index = 0; index < 2; index++) {
        if (JSON.stringify(await runWorkerThreadsExample()) !== expected) {
          throw new Error("Worker recipe failed on repeated invocation");
        }
      }
      if (JSON.stringify(await WorkerPrimesPipeline.runOrThrow({}, { maxConcurrency: 4 })) !== expected) {
        throw new Error("Worker recipe closed the shared pipeline adapter");
      }
    } finally { await primeAdapter.close(); }
  `,
    ],
    consumerRoot
  );

  const tubelessBin = join(consumerRoot, "node_modules", ".bin", "tubeless");
  if (!existsSync(tubelessBin)) {
    throw new Error("Packed tubeless artifact is missing the tubeless executable");
  }
  assertPackedLauncher(installedPackage, tubelessBin, consumerRoot);
  assertPackedExecutable(tubelessBin, installedPackage, consumerRoot);
  run(
    process.execPath,
    [join(packageRoot, "scripts/fixtures/packed-cloud-check.mjs"), tubelessBin],
    consumerRoot
  );

  process.stdout.write(
    `Packed tubeless artifact layout, declarations, imports, and executable verified with typescript ${packageJson.devDependencies.typescript} and typescript-floor ${floorVersion}.\n`
  );
} finally {
  rmSync(temporaryRoot, { force: true, recursive: true });
}
