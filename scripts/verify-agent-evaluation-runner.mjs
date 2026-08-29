import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { packedTarballFilename, resolveNpm } from "./resolve-npm.mjs";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const runnerPath = join(packageRoot, "scripts", "evaluate-agent-submission.mjs");
const fixtureRoot = join(packageRoot, "scripts", "fixtures", "agent-evaluation");
const answerRoot = join(packageRoot, "evals", "answers");
const casesPath = join(packageRoot, "evals", "agent-cases.json");
const temporaryRoot = mkdtempSync(join(tmpdir(), "tubeless-agent-eval-verifier-"));
const npm = resolveNpm();

function run(command, args, cwd) {
  return spawnSync(command, args, { cwd, encoding: "utf8", stdio: "pipe" });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function evaluate(submissionPath, packageArtifact, reportPath, caseId) {
  const args = [
    runnerPath,
    "--case",
    caseId,
    "--submission",
    submissionPath,
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
      `Evaluation ${caseId} at ${submissionPath} returned invalid JSON:\n${result.stdout}\n${result.stderr}`
    );
  }
  return { report, result };
}

function evaluateFixture(name, packageArtifact, reportPath) {
  return evaluate(join(fixtureRoot, name), packageArtifact, reportPath, "sequential-import");
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
  const valid = evaluateFixture("valid", packageArtifact, validReportPath);
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

  const invented = evaluateFixture("invented-api", packageArtifact);
  assert(invented.result.status === 1, "Invented API evaluation should fail.");
  assert(invented.report.compile.status === "failed", "Invented API should not compile.");
  assert(invented.report.mechanicalStatus === "failed", "Invented API mechanics should fail.");

  const artifactMetadata = evaluateFixture("artifact-metadata", createArtifactMetadataPackage());
  assert(artifactMetadata.result.status === 0, "Artifact-specific export should pass.");
  assert(
    artifactMetadata.report.package.version === "9.9.9-eval",
    "Artifact-specific version was not reported."
  );

  const tsxHelper = evaluateFixture("tsx-helper", packageArtifact);
  assert(tsxHelper.result.status === 0, "TSX helper evaluation should pass.");
  assert(tsxHelper.report.compile.status === "passed", "TSX helper should compile.");
  assert(tsxHelper.report.submission.files.includes("helper.tsx"), "TSX helper was not included.");

  const cases = JSON.parse(readFileSync(casesPath, "utf8"));
  const gated = cases.cases.filter((evaluation) => evaluation.learningSurfaceGate === true);
  assert(gated.length >= 4, "Need at least four learning-surface gate cases.");
  for (const evaluation of gated) {
    const answer = evaluate(
      join(answerRoot, evaluation.id),
      packageArtifact,
      undefined,
      evaluation.id
    );
    assert(
      answer.result.status === 0,
      `Answer ${evaluation.id} failed:\n${answer.result.stderr}\n${answer.result.stdout}`
    );
    assert(answer.report.ok === true, `Answer ${evaluation.id} should pass.`);
    assert(
      answer.report.mechanicalStatus === "passed",
      `Answer ${evaluation.id} should compile against public declarations.`
    );
    assert(
      answer.report.assessmentStatus === "passed",
      `Answer ${evaluation.id} must fully assess every expectation.`
    );
    assert(
      answer.report.case.id === evaluation.id,
      `Answer ${evaluation.id} reported the wrong case.`
    );
  }

  process.stdout.write(
    "Agent evaluation compile, artifact, assessment, TSX, report, and answer fixtures verified.\n"
  );
} finally {
  rmSync(temporaryRoot, { force: true, recursive: true });
}
