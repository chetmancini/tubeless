import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { parseArgs } from "node:util";
import { packedTarballFilename, resolveNpm } from "./resolve-npm.mjs";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const casesPath = join(packageRoot, "evals", "agent-cases.json");
const packageRequire = createRequire(join(packageRoot, "package.json"));
const typeScriptRoot = dirname(packageRequire.resolve("typescript/package.json"));
const typeScriptCli = join(typeScriptRoot, "bin", "tsc");
const nodeTypesRoot = dirname(dirname(packageRequire.resolve("@types/node/package.json")));
const sourceExtensions = new Set([".cts", ".mts", ".ts", ".tsx"]);
const evaluatedPackageName = "tubeless";
const npm = resolveNpm();

const helpText = `Usage: bun run eval:agent -- --case <id> --submission <directory> [options]

Options:
  --case <id>          Case ID from evals/agent-cases.json
  --submission <path>  Directory containing solution.ts
  --assessment <path>  Operator assessment JSON (defaults to assessment.json in submission)
  --package <path>     Reuse an existing tubeless package tarball
  --report <path>      Also write the stable JSON report to this path
  -h, --help           Show this help

The evaluator compiles submissions but never executes them.
`;

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: "pipe",
  });
  return {
    exitCode: result.status ?? 1,
    stderr: result.error
      ? `${result.stderr ?? ""}\n${result.error.message}`
      : (result.stderr ?? ""),
    stdout: result.stdout ?? "",
  };
}

function assertSuccessful(result, label) {
  if (result.exitCode !== 0) {
    throw new Error(`${label} failed:\n${result.stdout}\n${result.stderr}`.trim());
  }
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(
      `${label} is not valid JSON: ${error instanceof Error ? error.message : error}`
    );
  }
}

function listSourceFiles(root) {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Submission may not contain symbolic links: ${relative(root, path)}`);
      }
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && sourceExtensions.has(extname(entry.name))) files.push(path);
    }
  };
  visit(root);
  return files.sort((left, right) => relative(root, left).localeCompare(relative(root, right)));
}

function normalizeOutput(value, temporaryRoot) {
  return value
    .replaceAll(temporaryRoot, "<evaluation>")
    .replaceAll(temporaryRoot.replaceAll("\\", "/"), "<evaluation>")
    .trim();
}

function compilerDiagnostics(result, temporaryRoot) {
  return normalizeOutput(`${result.stdout}\n${result.stderr}`, temporaryRoot)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function loadCase(caseId) {
  const document = readJson(casesPath, "Agent cases");
  const evaluationCase = document.cases?.find(({ id }) => id === caseId);
  if (!evaluationCase) {
    const choices = document.cases?.map(({ id }) => id).join(", ") ?? "none";
    throw new Error(`Unknown agent case "${caseId}". Available cases: ${choices}`);
  }
  return evaluationCase;
}

function loadAssessment(path, evaluationCase) {
  if (!path || !existsSync(path)) return undefined;
  const assessment = readJson(path, "Assessment");
  if (assessment.schemaVersion !== 1) throw new Error("Assessment schemaVersion must be 1.");
  if (assessment.caseId !== evaluationCase.id) {
    throw new Error(`Assessment caseId must be "${evaluationCase.id}".`);
  }
  if (!Array.isArray(assessment.expectations)) {
    throw new Error("Assessment expectations must be an array.");
  }
  const allowed = new Set(
    [
      ...evaluationCase.mustDemonstrate.map((expectation) => ["mustDemonstrate", expectation]),
      ...evaluationCase.mustAvoid.map((expectation) => ["mustAvoid", expectation]),
    ].map(([category, expectation]) => `${category}\0${expectation}`)
  );
  const entries = new Map();
  for (const entry of assessment.expectations) {
    const key = `${entry.category}\0${entry.expectation}`;
    if (!allowed.has(key)) throw new Error(`Assessment contains unknown expectation: ${key}`);
    if (entries.has(key)) throw new Error(`Assessment repeats expectation: ${key}`);
    if (entry.status !== "pass" && entry.status !== "fail") {
      throw new Error(`Assessment status for ${key} must be pass or fail.`);
    }
    if (entry.evidence !== undefined && typeof entry.evidence !== "string") {
      throw new Error(`Assessment evidence for ${key} must be a string.`);
    }
    entries.set(key, entry);
  }
  return entries;
}

function expectationReport(evaluationCase, assessment) {
  const build = (category, expectations) =>
    expectations.map((expectation) => {
      const assessed = assessment?.get(`${category}\0${expectation}`);
      const scored = {
        expectation,
        status: assessed?.status ?? "unscored",
      };
      if (assessed?.evidence) scored.evidence = assessed.evidence;
      return scored;
    });
  const report = {
    mustAvoid: build("mustAvoid", evaluationCase.mustAvoid),
    mustDemonstrate: build("mustDemonstrate", evaluationCase.mustDemonstrate),
  };
  const statuses = [...report.mustDemonstrate, ...report.mustAvoid].map(({ status }) => status);
  const status = statuses.includes("fail")
    ? "failed"
    : statuses.every((value) => value === "pass")
      ? "passed"
      : "unscored";
  return { report, status };
}

function createPackageArtifact(temporaryRoot) {
  const build = run("node", [typeScriptCli, "-p", "tsconfig.json"], packageRoot);
  assertSuccessful(build, "tubeless build");
  const packed = run(
    npm,
    ["pack", "--ignore-scripts", "--json", "--pack-destination", temporaryRoot],
    packageRoot
  );
  assertSuccessful(packed, "tubeless pack");
  return join(temporaryRoot, packedTarballFilename(packed.stdout));
}

function prepareProject(temporaryRoot, submissionRoot, sourceFiles, packageArtifact) {
  const projectRoot = join(temporaryRoot, "project");
  const copiedSubmission = join(projectRoot, "submission");
  mkdirSync(copiedSubmission, { recursive: true });
  writeFileSync(
    join(projectRoot, "package.json"),
    `${JSON.stringify({ name: "tubeless-agent-evaluation", private: true, type: "module" }, null, 2)}\n`
  );
  const install = run(
    npm,
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--no-package-lock",
      packageArtifact,
    ],
    projectRoot
  );
  assertSuccessful(install, "Packed tubeless install");
  const packageJson = readJson(
    join(projectRoot, "node_modules", ...evaluatedPackageName.split("/"), "package.json"),
    `Installed ${evaluatedPackageName} package.json`
  );
  if (packageJson.name !== evaluatedPackageName) {
    throw new Error(`Package artifact must contain ${evaluatedPackageName}.`);
  }
  for (const sourceFile of sourceFiles) {
    const destination = join(copiedSubmission, relative(submissionRoot, sourceFile));
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(sourceFile, destination);
  }
  writeFileSync(
    join(projectRoot, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          esModuleInterop: true,
          jsx: "preserve",
          lib: ["ES2022", "DOM"],
          module: "NodeNext",
          moduleResolution: "NodeNext",
          noEmit: true,
          skipLibCheck: true,
          strict: true,
          target: "ES2022",
          typeRoots: [nodeTypesRoot],
          types: ["node"],
          verbatimModuleSyntax: true,
        },
        include: [
          "submission/**/*.ts",
          "submission/**/*.tsx",
          "submission/**/*.mts",
          "submission/**/*.cts",
        ],
      },
      null,
      2
    )}\n`
  );
  return { packageJson, projectRoot };
}

export function evaluateAgentSubmission({ assessmentPath, caseId, packagePath, submissionPath }) {
  const evaluationCase = loadCase(caseId);
  if (!existsSync(typeScriptCli)) throw new Error(`TypeScript CLI is missing: ${typeScriptCli}`);
  if (!existsSync(nodeTypesRoot)) {
    throw new Error(`Node type declarations are missing: ${nodeTypesRoot}`);
  }
  const submissionRoot = resolve(submissionPath);
  if (!existsSync(submissionRoot)) {
    throw new Error(`Submission directory does not exist: ${submissionRoot}`);
  }
  const solutionPath = join(submissionRoot, "solution.ts");
  if (!existsSync(solutionPath) || !lstatSync(solutionPath).isFile()) {
    throw new Error("Submission must contain solution.ts as a regular file.");
  }
  const sourceFiles = listSourceFiles(submissionRoot);
  const sourceNames = sourceFiles.map((file) =>
    relative(submissionRoot, file).replaceAll("\\", "/")
  );
  const resolvedAssessment = resolve(assessmentPath ?? join(submissionRoot, "assessment.json"));
  if (assessmentPath && !existsSync(resolvedAssessment)) {
    throw new Error(`Assessment file does not exist: ${resolvedAssessment}`);
  }
  const assessment = loadAssessment(resolvedAssessment, evaluationCase);
  const expectations = expectationReport(evaluationCase, assessment);
  const temporaryRoot = mkdtempSync(join(tmpdir(), "tubeless-agent-eval-"));

  try {
    const artifact = packagePath ? resolve(packagePath) : createPackageArtifact(temporaryRoot);
    if (!existsSync(artifact)) throw new Error(`Package artifact does not exist: ${artifact}`);
    const { packageJson, projectRoot } = prepareProject(
      temporaryRoot,
      submissionRoot,
      sourceFiles,
      artifact
    );
    const compileResult = run(
      "node",
      [typeScriptCli, "-p", "tsconfig.json", "--pretty", "false"],
      projectRoot
    );
    const compileStatus = compileResult.exitCode === 0 ? "passed" : "failed";
    const mechanicalStatus = compileStatus;
    const ok = mechanicalStatus === "passed" && expectations.status !== "failed";
    return {
      schemaVersion: 1,
      assessmentStatus: expectations.status,
      case: { id: evaluationCase.id, prompt: evaluationCase.prompt },
      compile: {
        diagnostics: compilerDiagnostics(compileResult, temporaryRoot),
        status: compileStatus,
      },
      expectations: expectations.report,
      mechanicalStatus,
      ok,
      package: { name: packageJson.name, version: packageJson.version },
      submission: { files: sourceNames },
    };
  } finally {
    rmSync(temporaryRoot, { force: true, recursive: true });
  }
}

function parseCli(argv) {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: false,
    options: {
      assessment: { type: "string" },
      case: { type: "string" },
      help: { short: "h", type: "boolean" },
      package: { type: "string" },
      report: { type: "string" },
      submission: { type: "string" },
    },
    strict: true,
  });
  if (values.help) return { kind: "help" };
  if (!values.case || !values.submission) {
    throw new Error("--case and --submission are required.");
  }
  return { kind: "values", values };
}

export function runAgentEvaluationCli(argv = process.argv.slice(2)) {
  let parsed;
  try {
    parsed = parseCli(argv);
  } catch (error) {
    process.stderr.write(`Error: ${error instanceof Error ? error.message : error}\n\n${helpText}`);
    return 2;
  }
  if (parsed.kind === "help") {
    process.stdout.write(helpText);
    return 0;
  }
  try {
    const report = evaluateAgentSubmission({
      assessmentPath: parsed.values.assessment,
      caseId: parsed.values.case,
      packagePath: parsed.values.package,
      submissionPath: parsed.values.submission,
    });
    const output = `${JSON.stringify(report, null, 2)}\n`;
    if (parsed.values.report) {
      const reportPath = resolve(parsed.values.report);
      mkdirSync(dirname(reportPath), { recursive: true });
      writeFileSync(reportPath, output);
    }
    process.stdout.write(output);
    return report.ok ? 0 : 1;
  } catch (error) {
    process.stderr.write(`Error: ${error instanceof Error ? error.message : error}\n`);
    return 2;
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exitCode = runAgentEvaluationCli();
