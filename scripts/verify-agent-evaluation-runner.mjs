import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { packedTarballFilename, resolveNpm } from "./resolve-npm.mjs";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const runnerPath = join(packageRoot, "scripts", "evaluate-agent-submission.mjs");
const fixtureRoot = join(packageRoot, "scripts", "fixtures", "agent-evaluation");
const temporaryRoot = mkdtempSync(join(tmpdir(), "tubeless-agent-eval-verifier-"));
const npm = resolveNpm();

function run(command, args, cwd) {
  return spawnSync(command, args, { cwd, encoding: "utf8", stdio: "pipe" });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function evaluate(name, packageArtifact, reportPath) {
  const args = [
    runnerPath,
    "--case",
    "sequential-import",
    "--submission",
    join(fixtureRoot, name),
    "--package",
    packageArtifact,
  ];
  if (reportPath) args.push("--report", reportPath);
  const result = run("node", args, packageRoot);
  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    throw new Error(
      `Evaluation ${name} returned invalid JSON:\n${result.stdout}\n${result.stderr}`
    );
  }
  return { report, result };
}

function createArtifactMetadataPackage() {
  const artifactRoot = join(temporaryRoot, "artifact-metadata-package");
  mkdirSync(artifactRoot, { recursive: true });
  writeFileSync(
    join(artifactRoot, "package.json"),
    `${JSON.stringify(
      {
        name: "tubeless",
        version: "9.9.9-eval",
        type: "module",
        exports: {
          "./artifact-only": {
            types: "./artifact-only.d.ts",
            import: "./artifact-only.js",
          },
        },
      },
      null,
      2
    )}\n`
  );
  writeFileSync(
    join(artifactRoot, "artifact-only.d.ts"),
    "export declare const artifactValue = 42;\n"
  );
  writeFileSync(join(artifactRoot, "artifact-only.js"), "export const artifactValue = 42;\n");
  const packed = run(
    npm,
    ["pack", "--ignore-scripts", "--json", "--pack-destination", temporaryRoot],
    artifactRoot
  );
  assert(
    packed.status === 0,
    `Artifact metadata package failed:\n${packed.stdout}\n${packed.stderr}`
  );
  return join(temporaryRoot, packedTarballFilename(packed.stdout));
}

try {
  const packed = run(
    npm,
    ["pack", "--ignore-scripts", "--json", "--pack-destination", temporaryRoot],
    packageRoot
  );
  assert(packed.status === 0, `Package fixture failed:\n${packed.stdout}\n${packed.stderr}`);
  const packageArtifact = join(temporaryRoot, packedTarballFilename(packed.stdout));

  const validReportPath = join(temporaryRoot, "reports", "valid.json");
  const valid = evaluate("valid", packageArtifact, validReportPath);
  assert(valid.result.status === 0, `Valid evaluation failed:\n${valid.result.stderr}`);
  assert(valid.report.ok === true, "Valid evaluation should pass.");
  assert(valid.report.mechanicalStatus === "passed", "Valid mechanical status should pass.");
  assert(valid.report.assessmentStatus === "passed", "Valid assessment status should pass.");
  assert(valid.report.compile.status === "passed", "Valid solution should compile.");
  assert(existsSync(validReportPath), "--report did not write its output.");
  assert(
    JSON.stringify(JSON.parse(readFileSync(validReportPath, "utf8"))) ===
      JSON.stringify(valid.report),
    "File and stdout reports differ."
  );

  const invented = evaluate("invented-api", packageArtifact);
  assert(invented.result.status === 1, "Invented API evaluation should fail.");
  assert(invented.report.compile.status === "failed", "Invented API should not compile.");
  assert(invented.report.mechanicalStatus === "failed", "Invented API mechanics should fail.");

  const artifactMetadata = evaluate("artifact-metadata", createArtifactMetadataPackage());
  assert(artifactMetadata.result.status === 0, "Artifact-specific export should pass.");
  assert(
    artifactMetadata.report.package.version === "9.9.9-eval",
    "Artifact-specific version was not reported."
  );

  const tsxHelper = evaluate("tsx-helper", packageArtifact);
  assert(tsxHelper.result.status === 0, "TSX helper evaluation should pass.");
  assert(tsxHelper.report.compile.status === "passed", "TSX helper should compile.");
  assert(tsxHelper.report.submission.files.includes("helper.tsx"), "TSX helper was not included.");

  process.stdout.write(
    "Agent evaluation compile, artifact, assessment, TSX, and report fixtures verified.\n"
  );
} finally {
  rmSync(temporaryRoot, { force: true, recursive: true });
}
