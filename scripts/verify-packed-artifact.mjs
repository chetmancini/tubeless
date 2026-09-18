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
import { basename, dirname, join, resolve } from "node:path";
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
    "docs/remote-step-composition.md",
    "docs/cli.md",
    "docs/concepts.md",
    "docs/getting-started.md",
    "docs/llms.txt",
    "docs/recipes.md",
    "docs/studio.md",
    "examples/typed-import.ts",
    "examples/catalog/tubeless.project.ts",
    "examples/catalog/pipelines/import.ts",
    "examples/catalog/pipelines/enrich.ts",
    "examples/catalog/scripts/import.ts",
    "examples/catalog/scripts/enrich.ts",
  ]) {
    if (!existsSync(join(installedPackage, relativePath))) {
      throw new Error(`Packed tubeless artifact is missing ${relativePath}`);
    }
  }
  if (existsSync(join(installedPackage, "docs", "superpowers"))) {
    throw new Error("Packed tubeless artifact must not include docs/superpowers");
  }
  assertPackedSourceMaps(installedPackage);
  assertPackedDocumentationLinks(installedPackage);

  // Consumer declarations must compile without ambient Node typings or skipLibCheck.
  writeFileSync(
    join(consumerRoot, "cli.ts"),
    readFileSync(join(packageRoot, "scripts/fixtures/packed-consumer/cli.ts"))
  );
  writeFileSync(
    join(consumerRoot, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        lib: ["ES2022", "DOM"],
        module: "NodeNext",
        noEmit: true,
        skipLibCheck: false,
        strict: true,
        target: "ES2022",
        types: [],
      },
      files: ["cli.ts"],
    })
  );
  run(join(packageRoot, "node_modules/.bin/tsc"), ["-p", "tsconfig.json"], consumerRoot);

  const smokeProgram = Object.keys(packageJson.exports)
    .map((subpath) =>
      JSON.stringify(subpath === "." ? packageJson.name : `${packageJson.name}/${subpath.slice(2)}`)
    )
    .map((specifier) => `await import(${specifier});`)
    .join("\n");
  run("node", ["--input-type=module", "--eval", smokeProgram], consumerRoot);

  const tubelessBin = join(consumerRoot, "node_modules", ".bin", "tubeless");
  if (!existsSync(tubelessBin)) {
    throw new Error("Packed tubeless artifact is missing the tubeless executable");
  }
  assertPackedExecutable(tubelessBin, installedPackage, consumerRoot);

  process.stdout.write(
    "Packed tubeless artifact layout, declarations, imports, and executable verified.\n"
  );
} finally {
  rmSync(temporaryRoot, { force: true, recursive: true });
}
